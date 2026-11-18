import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../agent-hooks/server/agent-hook-server'
import { AgentTransitionDetector } from '../agent-hooks/observations/agent-transition-detector'
import { structuredAgentSessionStatusPaneKey } from '../../shared/agent-session/view/structured-agent-session-tab'
import {
  botPhaseChangeScopes,
  BotChangeNotices,
  followAgentPhasesForBots,
  followWorktreeLifecycleForBots
} from './bot-change-notices'
import { botChangeBotIds, botChangeConcerns } from '../../shared/bots/bot-change-scope'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

describe('BotChangeNotices', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sends the first change on the next tick, then one notice per quiet window', () => {
    const emit = vi.fn()
    const notices = new BotChangeNotices({ emit, hasBots: () => true, delayMs: 500 })
    notices.changed()
    notices.changed()
    expect(emit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(0)
    expect(emit).toHaveBeenCalledTimes(1)
    notices.changed()
    notices.changed()
    vi.advanceTimersByTime(499)
    expect(emit).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(emit).toHaveBeenCalledTimes(2)
    // A window with no change ends the run; the next change goes out at once again.
    vi.advanceTimersByTime(500)
    expect(emit).toHaveBeenCalledTimes(2)
    notices.changed()
    vi.advanceTimersByTime(0)
    expect(emit).toHaveBeenCalledTimes(3)
  })

  it('says which bots and kinds a notice covers, keeping each kind to its own bots', () => {
    const emit = vi.fn()
    const notices = new BotChangeNotices({ emit, hasBots: () => true, delayMs: 500 })
    notices.changed({ botIds: ['bot-a'], kinds: ['chats'] })
    notices.changed({ botIds: ['bot-b'], kinds: ['chats'] })
    vi.advanceTimersByTime(0)
    expect(emit).toHaveBeenLastCalledWith({ botIds: ['bot-a', 'bot-b'], kinds: ['chats'] })
    // An automations change for every bot leaves bot-a's worker change to bot-a's readers.
    notices.changed({ botIds: ['bot-a'], kinds: ['workers'] })
    notices.changed({ kinds: ['automations'] })
    vi.advanceTimersByTime(500)
    const mixed = emit.mock.lastCall?.[0]
    expect(mixed).toEqual({
      kinds: ['workers', 'automations'],
      kindBots: { workers: ['bot-a'] }
    })
    expect(botChangeConcerns(mixed, { botId: 'bot-b', kinds: ['workers'] })).toBe(false)
    expect(botChangeConcerns(mixed, { botId: 'bot-a', kinds: ['workers'] })).toBe(true)
    expect(botChangeConcerns(mixed, { botId: 'bot-b', kinds: ['automations'] })).toBe(true)
    // A host-wide reader of per-bot values reads only the bots its own kinds name.
    expect(botChangeBotIds(mixed, ['workers', 'chats'])).toEqual(['bot-a'])
    expect(botChangeBotIds(mixed, ['automations'])).toBeNull()
    // A change of any kind to every bot covers the rest.
    notices.changed({ botIds: ['bot-a'], kinds: ['items'] })
    notices.changed()
    vi.advanceTimersByTime(500)
    expect(emit).toHaveBeenLastCalledWith({})
  })

  it("carries the host's Needs you counts on an items notice, one count per notice, in order", async () => {
    const emit = vi.fn()
    const answers: ((value: { counts: Record<string, number>; at: number }) => void)[] = []
    const needsYouCounts = vi.fn(
      () =>
        new Promise<{ counts: Record<string, number>; at: number }>((resolve) => {
          answers.push(resolve)
        })
    )
    const notices = new BotChangeNotices({
      emit,
      hasBots: () => true,
      needsYouCounts,
      delayMs: 500
    })
    notices.changed({ botIds: ['bot-a'], kinds: ['items'] })
    notices.changed({ botIds: ['bot-a'], kinds: ['items'] })
    vi.advanceTimersByTime(0)
    // A status notice behind it waits its turn, and counts nothing.
    notices.changed({ botIds: ['bot-a'], kinds: ['status'] })
    vi.advanceTimersByTime(500)
    expect(needsYouCounts).toHaveBeenCalledTimes(1)
    expect(emit).not.toHaveBeenCalled()
    answers[0]({ counts: { 'bot-a': 1 }, at: 10 })
    await vi.advanceTimersByTimeAsync(0)
    expect(emit.mock.calls).toEqual([
      [{ botIds: ['bot-a'], kinds: ['items'], needsYou: { counts: { 'bot-a': 1 }, at: 10 } }],
      [{ botIds: ['bot-a'], kinds: ['status'] }]
    ])
    // With nothing waiting, a notice of other kinds goes out at once.
    vi.advanceTimersByTime(500)
    notices.changed({ kinds: ['chats'] })
    vi.advanceTimersByTime(0)
    expect(emit).toHaveBeenLastCalledWith({ kinds: ['chats'] })
  })

  it.each([
    ['unreadable', async () => null],
    ['throws', () => Promise.reject(new Error('db closed'))]
  ])('sends an items notice bare when its count %s, never as zero', async (_, needsYouCounts) => {
    const emit = vi.fn()
    const notices = new BotChangeNotices({ emit, hasBots: () => true, needsYouCounts })
    notices.changed({ botIds: ['bot-a'], kinds: ['items'] })
    await vi.advanceTimersByTimeAsync(0)
    expect(emit.mock.calls).toEqual([[{ botIds: ['bot-a'], kinds: ['items'] }]])
  })

  it('stays quiet on a host without bots', () => {
    const emit = vi.fn()
    new BotChangeNotices({ emit, hasBots: () => false }).changed()
    vi.runAllTimers()
    expect(emit).not.toHaveBeenCalled()
  })
})

describe('followAgentPhasesForBots', () => {
  const WORKER_PANE = 'tab-a:22222222-2222-4222-8222-222222222222'
  const PLAIN_PANE = 'tab-b:33333333-3333-4333-8333-333333333333'
  const HOME_PANE = 'tab-c:44444444-4444-4444-8444-444444444444'

  function follow(hasBots = true) {
    const server = new AgentHookServer()
    const detector = new AgentTransitionDetector({
      resolveTabWorktreeId: () => undefined,
      subscribeToPtyExit: () => () => {},
      now: () => 1_000
    })
    detector.attach(server)
    const notices = { changed: vi.fn() }
    const botOfPane = vi.fn((paneKey: string) => (paneKey === WORKER_PANE ? 'bot-scout' : null))
    followAgentPhasesForBots(detector, notices, {
      hasBots: () => hasBots,
      botOfWorkspace: (worktreeId) => (worktreeId === 'folder:fw-scout' ? 'bot-scout' : null),
      botOfPane,
      inGroupRoom: () => false,
      workerPane: (paneKey) => paneKey === WORKER_PANE,
      readEveryBot: () => true
    })
    const report = (
      paneKey: string,
      worktreeId: string,
      state: 'working' | 'blocked' | 'done'
    ): void =>
      server.ingestTerminalStatus({
        paneKey,
        tabId: paneKey.split(':')[0],
        worktreeId,
        payload: { state, prompt: 'task', agentType: 'codex' }
      })
    return { notices, report, botOfPane }
  }

  it('notices each phase a worker moves through, from the host status store', () => {
    const { notices, report } = follow()
    report(WORKER_PANE, 'repo-1::/tmp/worker', 'working')
    const afterStart = notices.changed.mock.calls.length
    expect(afterStart).toBeGreaterThan(0)
    // Repeating a phase is a tick, not a change.
    report(WORKER_PANE, 'repo-1::/tmp/worker', 'working')
    expect(notices.changed).toHaveBeenCalledTimes(afterStart)
    report(WORKER_PANE, 'repo-1::/tmp/worker', 'blocked')
    expect(notices.changed).toHaveBeenCalledTimes(afterStart + 1)
    report(WORKER_PANE, 'repo-1::/tmp/worker', 'done')
    expect(notices.changed).toHaveBeenCalledTimes(afterStart + 2)
  })

  it("tells a worker's phase to its bot's worker readers, so a linked item re-reads its state", () => {
    const { notices, report } = follow()
    report(WORKER_PANE, 'repo-1::/tmp/worker', 'working')
    expect(notices.changed).toHaveBeenCalledWith({
      botIds: ['bot-scout'],
      kinds: ['status', 'workers']
    })
  })

  it('notices a bot home pane, and not a plain agent in a project worktree', () => {
    const { notices, report } = follow()
    for (const state of ['working', 'blocked', 'done'] as const) {
      report(PLAIN_PANE, 'repo-1::/tmp/feature', state)
    }
    expect(notices.changed).not.toHaveBeenCalled()
    report(HOME_PANE, 'folder:fw-scout', 'working')
    expect(notices.changed).toHaveBeenCalledExactlyOnceWith({
      botIds: ['bot-scout'],
      kinds: ['status']
    })
  })

  it('looks nothing up on a host without bots', () => {
    const { notices, report, botOfPane } = follow(false)
    report(WORKER_PANE, 'repo-1::/tmp/worker', 'working')
    expect(notices.changed).not.toHaveBeenCalled()
    expect(botOfPane).not.toHaveBeenCalled()
  })
})

describe('botPhaseChangeScopes', () => {
  const chat = structuredAgentSessionStatusPaneKey('session-1')
  const facts = {
    botOfWorkspace: () => null,
    botOfPane: (paneKey: string) => (paneKey === chat ? 'bot-a' : null),
    inGroupRoom: (sessionId: string) => sessionId === 'session-room',
    workerPane: (paneKey: string) => paneKey === 'tab-w:55555555-5555-4555-8555-555555555555',
    readEveryBot: () => false
  }

  it("names only the bot whose chat it is, and nothing for a chat outside every bot's home", () => {
    expect(
      botPhaseChangeScopes(
        { kind: 'moved', paneKey: chat, workspace: { worktreeId: 'folder:fw-a' } },
        facts
      )
    ).toEqual([{ botIds: ['bot-a'], kinds: ['status'] }])
    const elsewhere = structuredAgentSessionStatusPaneKey('session-2')
    expect(
      botPhaseChangeScopes(
        { kind: 'moved', paneKey: elsewhere, workspace: { worktreeId: 'repo-1::/x' } },
        facts
      )
    ).toEqual([])
  })

  it('reads never-read bots once to place a worker pane, then tells only its bot', () => {
    const worker = 'tab-w:55555555-5555-4555-8555-555555555555'
    let read = false
    expect(
      botPhaseChangeScopes(
        { kind: 'moved', paneKey: worker, workspace: { worktreeId: 'repo-1::/w' } },
        {
          ...facts,
          botOfPane: (paneKey: string) => (read && paneKey === worker ? 'bot-b' : null),
          readEveryBot: () => {
            read = true
            return true
          }
        }
      )
    ).toEqual([{ botIds: ['bot-b'], kinds: ['status', 'workers'] }])
  })

  it("tells every bot of a worker pane it can't place when some bot's chats can't be read", () => {
    expect(
      botPhaseChangeScopes(
        {
          kind: 'moved',
          paneKey: 'tab-w:55555555-5555-4555-8555-555555555555',
          workspace: { worktreeId: 'repo-1::/w' }
        },
        facts
      )
    ).toEqual([{ kinds: ['status', 'workers'] }])
  })

  it("tells the groups of a member's phase in a group room", () => {
    const member = structuredAgentSessionStatusPaneKey('session-room')
    expect(
      botPhaseChangeScopes({ kind: 'moved', paneKey: member, workspace: null }, facts)
    ).toEqual([{ kinds: ['groups'] }])
  })
})

describe('followWorktreeLifecycleForBots', () => {
  it("tells a worker's new or removed worktree to the bot it sits under, and no one else", () => {
    const listeners = new Set<(event: { worktreeId: string }) => void>()
    const notices = { changed: vi.fn() }
    const release = followWorktreeLifecycleForBots(
      (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      notices,
      (worktreeId) =>
        worktreeId === 'repo::/worker' ? { botIds: ['bot-a'], kinds: ['workers'] } : null
    )
    listeners.forEach((listener) => listener({ worktreeId: 'repo::/worker' }))
    listeners.forEach((listener) => listener({ worktreeId: 'repo::/feature' }))
    expect(notices.changed).toHaveBeenCalledExactlyOnceWith({
      botIds: ['bot-a'],
      kinds: ['workers']
    })
    release()
    expect(listeners.size).toBe(0)
  })
})
