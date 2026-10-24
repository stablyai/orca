import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { AgentPhase, AgentTransition } from '../../shared/agent-transitions'
import type { ConversationEvent, ConversationSnapshot } from './external-conversation-events'
import type { ConversationKey } from './external-conversation-types'
import {
  fakeLauncher,
  fakeTerminal,
  launchResult,
  PANE,
  WORKTREE
} from './external-conversation.test-fixture'
import { harness, terminalConsumers } from './external-conversation-seam.test-fixture'
import { AGENT_DONE_QUIET_MS } from '../../shared/agent-transitions'
import * as hookOnly from '../../renderer/src/components/terminal-pane/agent-completion-hook-only-observer'
import type { AgentCompletionHookCandidate } from '../../renderer/src/components/terminal-pane/agent-completion-coordinator-types'

const KEY: ConversationKey = { source: 'dev', externalId: 'thread-1' }
const START = {
  agent: 'claude',
  target: { kind: 'existing' as const, worktree: `id:${WORKTREE}` },
  prompt: 'first'
}

function hookRow(overrides: Partial<AgentStatusIpcPayload>): AgentStatusIpcPayload {
  return {
    state: 'working',
    prompt: '',
    agentType: 'claude',
    paneKey: PANE,
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 100,
    ...overrides
  }
}

const APPROVAL = hookRow({
  state: 'waiting',
  stateStartedAt: 200,
  interactivePrompt: JSON.stringify({ approval: { tool: 'Bash', summary: 'ls' } })
})

function moved(
  from: AgentPhase,
  to: AgentPhase,
  transition: AgentTransition | null
): AgentPaneChange {
  return {
    kind: 'moved',
    paneKey: PANE,
    workspace: { worktreeId: WORKTREE, sshHostId: null },
    from,
    to,
    at: 1,
    transition
  }
}

function observeThenMove(
  publish: (change: AgentPaneChange) => void,
  change: AgentPaneChange
): void {
  if (change.kind !== 'moved') {
    throw new Error('Expected the fixture phase movement')
  }
  publish({
    kind: 'observed',
    paneKey: change.paneKey,
    workspace: change.workspace,
    phase: change.to,
    at: change.at
  })
  publish(change)
}

function captureCandidates() {
  const observed: { connector: boolean; candidate: AgentCompletionHookCandidate }[] = []
  const create = hookOnly.createHookOnlyCompletionObserver
  const spy = vi.spyOn(hookOnly, 'createHookOnlyCompletionObserver').mockImplementation((input) =>
    create({
      ...input,
      dispatch: (candidate) => {
        observed.push({ connector: input.identityScope !== undefined, candidate })
        input.dispatch(candidate)
      }
    })
  )
  return { observed, restore: () => spy.mockRestore() }
}

async function linked(settings = {}) {
  const h = harness(settings)
  const fake = fakeTerminal()
  const host = {
    launcher: fakeLauncher(async () => launchResult('handed-to-terminal')).launcher,
    terminal: fake.terminal
  }
  await h.seam.start(host, KEY, 'd1', START)
  return { ...h, fake, host }
}

describe('ExternalConversationSeam prompts', () => {
  it('reads the linked agent’s approval and answers it once, by its exact id', async () => {
    const { seam, host, hookRows, fake } = await linked()
    expect(seam.pendingPrompt(host, KEY)).toBeNull()
    hookRows.set(PANE, APPROVAL)
    const prompt = seam.pendingPrompt(host, KEY)
    expect(prompt).toMatchObject({ kind: 'approval', tool: 'Bash', summary: 'ls' })
    await expect(seam.answer(host, KEY, prompt!.promptId, 'allow_once')).resolves.toEqual({
      outcome: 'accepted'
    })
    expect(fake.keys).toEqual(['1'])
    await expect(seam.answer(host, KEY, prompt!.promptId, 'allow_once')).resolves.toEqual({
      outcome: 'refused',
      reason: 'prompt_not_pending'
    })
    expect(fake.keys).toEqual(['1'])
  })

  it('refuses an answer for a stale prompt, a replaced process, or a shell in front', async () => {
    const { seam, host, hookRows, fake } = await linked()
    hookRows.set(PANE, APPROVAL)
    const { promptId } = seam.pendingPrompt(host, KEY)!
    fake.replace()
    await expect(seam.answer(host, KEY, promptId, 'allow_once')).resolves.toMatchObject({
      reason: 'prompt_not_pending'
    })
    const fresh = seam.pendingPrompt(host, KEY)!.promptId
    fake.terminal.readLaunchedAgentForeground.mockResolvedValueOnce('shell')
    await expect(seam.answer(host, KEY, fresh, 'reject_once')).resolves.toMatchObject({
      reason: 'agent_not_reachable'
    })
    expect(fake.keys).toEqual([])
  })

  it('reads a prompt as unsupported once the agent’s hooks are off', async () => {
    const settings: { agentStatusHooksEnabled?: boolean } = {}
    const { seam, host, hookRows } = await linked(settings)
    hookRows.set(PANE, APPROVAL)
    settings.agentStatusHooksEnabled = false
    const prompt = seam.pendingPrompt(host, KEY)!
    expect(prompt.kind).toBe('unsupported')
    await expect(seam.answer(host, KEY, prompt.promptId, 'allow_once')).resolves.toMatchObject({
      reason: 'prompt_unsupported'
    })
  })

  it('throws for a conversation with no link, and refuses once connectors are off', async () => {
    const { seam, host } = await linked()
    const other = { source: 'dev' as const, externalId: 'nope' }
    expect(() => seam.pendingPrompt(host, other)).toThrow('external_conversation_not_found')
    seam.dispose('connectors_disabled')
    await expect(seam.answer(host, KEY, 'p', 'allow_once')).resolves.toEqual({
      outcome: 'refused',
      reason: 'connectors_disabled'
    })
    expect(() => seam.watch(host, () => {})).toThrow('connectors_disabled')
  })
})

describe('ExternalConversationSeam watch', () => {
  beforeEach(() => vi.useFakeTimers({ now: 10_000 }))
  afterEach(() => vi.useRealTimers())
  it('subscribes only while watched, and opens with a snapshot of every link', async () => {
    const { seam, host, paneListeners, hookRows } = await linked()
    expect(paneListeners.size).toBe(0)
    hookRows.set(PANE, APPROVAL)
    const seen: (ConversationSnapshot | ConversationEvent)[] = []
    const release = seam.watch(host, (event) => seen.push(event))
    expect(paneListeners.size).toBe(1)
    expect(seen).toEqual([
      {
        kind: 'snapshot',
        conversations: [
          expect.objectContaining({
            conversation: KEY,
            paneKey: PANE,
            agent: 'claude',
            working: false,
            prompt: expect.objectContaining({ kind: 'approval' })
          })
        ]
      }
    ])
    release()
    expect(paneListeners.size).toBe(0)
  })

  it('does not deliver a previous watcher’s queued finish to a new watcher', async () => {
    const h = await linked()
    const consumers = terminalConsumers(h)
    const capture = captureCandidates()
    try {
      const release = h.seam.watch(h.host, () => {})
      const working = hookRow({
        worktreeId: WORKTREE,
        state: 'working',
        turnStartedAt: 100,
        terminalHandle: 'term-1',
        runId: 'run-1',
        executionId: 'execution-1'
      })
      consumers.report(working)
      const done = {
        ...working,
        state: 'done' as const,
        stateStartedAt: 300,
        receivedAt: 301,
        lastAssistantMessage: 'Original finish.'
      }
      consumers.report(done)
      expect(consumers.changes.slice(-2).map((change) => change.kind)).toEqual([
        'observed',
        'moved'
      ])
      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2)
      expect(consumers.alerts).toEqual([])
      release()
      const seen: (ConversationSnapshot | ConversationEvent)[] = []
      const releaseNew = h.seam.watch(h.host, (event) => seen.push(event))
      consumers.report({
        ...done,
        sessionBoundary: true,
        receivedAt: 999,
        lastAssistantMessage: 'Ignored later boundary.'
      })
      await vi.advanceTimersByTimeAsync(AGENT_DONE_QUIET_MS)
      expect(seen.map((event) => event.kind)).toEqual(['snapshot'])
      expect(consumers.alerts).toHaveLength(1)
      expect(consumers.alerts[0].body).toContain('Original finish.')
      expect(capture.observed).toHaveLength(1)
      expect(capture.observed[0].connector).toBe(false)
      expect(capture.observed[0].candidate.originalRow).toBe(done)
      expect(capture.observed[0].candidate.snapshot).toBe(done)
      expect(done.receivedAt).toBe(301)

      consumers.report({ ...working, stateStartedAt: 400, turnStartedAt: 400 })
      consumers.report({ ...done, stateStartedAt: 600, receivedAt: 601 })
      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2)
      consumers.report({
        ...done,
        sessionBoundary: true,
        runId: 'replacement-run',
        executionId: 'replacement-execution',
        receivedAt: 700
      })
      await vi.advanceTimersByTimeAsync(AGENT_DONE_QUIET_MS)
      expect(consumers.alerts).toHaveLength(1)
      expect(capture.observed).toHaveLength(1)
      releaseNew()
    } finally {
      h.seam.dispose('connectors_disabled')
      consumers.dispose()
      capture.restore()
    }
  })

  it('reports no outcome when a completed hook turn records no verdict', async () => {
    const { seam, host, hookRows, paneChange } = await linked()
    const seen: (ConversationSnapshot | ConversationEvent)[] = []
    seam.watch(host, (event) => seen.push(event))
    hookRows.set(PANE, hookRow({ state: 'working' }))
    observeThenMove(paneChange, moved('rest', 'working', 'prompt-submitted'))
    hookRows.set(PANE, hookRow({ state: 'done', stateStartedAt: 300 }))
    observeThenMove(paneChange, moved('working', 'done', 'turn-finished'))
    await vi.advanceTimersByTimeAsync(AGENT_DONE_QUIET_MS)
    expect(seen.at(-1)).toMatchObject({ kind: 'turn-ended', stopReason: null })
  })

  it('tells a linked turn’s start, its prompt, and its end with the host’s verdict', async () => {
    const { seam, host, hookRows, paneChange } = await linked()
    const seen: ConversationEvent[] = []
    seam.watch(host, (event) => {
      if (event.kind !== 'snapshot') {
        seen.push(event)
      }
    })
    hookRows.set(PANE, hookRow({ state: 'working', turnStartedAt: 100 }))
    observeThenMove(paneChange, moved('rest', 'working', 'prompt-submitted'))
    hookRows.set(PANE, APPROVAL)
    observeThenMove(paneChange, moved('working', 'needs-you', 'needs-input'))
    hookRows.set(
      PANE,
      hookRow({
        state: 'done',
        stateStartedAt: 300,
        lastAssistantMessage: 'Done.',
        mainAgent: { state: 'done', stateStartedAt: 300, outcome: 'success' }
      })
    )
    observeThenMove(paneChange, moved('needs-you', 'done', 'turn-finished'))
    await vi.advanceTimersByTimeAsync(AGENT_DONE_QUIET_MS)
    expect(seen.map((event) => event.kind)).toEqual(['turn-started', 'prompt', 'turn-ended'])
    expect(seen[0]).toMatchObject({ conversation: KEY, at: 100 })
    expect(seen[1]).toMatchObject({ prompt: { kind: 'approval' } })
    expect(seen[2]).toMatchObject({ stopReason: 'success', lastAssistantMessage: 'Done.', at: 300 })
  })

  it('ends a turn the user stopped with its recorded verdict, never the caller’s', async () => {
    const { seam, host, hookRows, paneChange } = await linked()
    const seen: ConversationEvent[] = []
    seam.watch(host, (event) => {
      if (event.kind !== 'snapshot') {
        seen.push(event)
      }
    })
    hookRows.set(PANE, hookRow({ state: 'working' }))
    observeThenMove(paneChange, moved('rest', 'working', 'prompt-submitted'))
    hookRows.set(PANE, hookRow({ state: 'done', stateStartedAt: 150, interrupted: true }))
    observeThenMove(paneChange, moved('working', 'rest', null))
    expect(seen.at(-1)).toMatchObject({ kind: 'turn-ended', stopReason: 'cancellation' })
  })

  it('tells nothing for a pane no conversation links, nor a done from before the turn', async () => {
    const { seam, host, hookRows, paneChange } = await linked()
    const seen: ConversationEvent[] = []
    seam.watch(host, (event) => {
      if (event.kind !== 'snapshot') {
        seen.push(event)
      }
    })
    hookRows.set(PANE, hookRow({ state: 'working', turnStartedAt: 500 }))
    observeThenMove(paneChange, moved('rest', 'working', 'prompt-submitted'))
    hookRows.set(PANE, hookRow({ state: 'done', stateStartedAt: 400, sessionBoundary: false }))
    observeThenMove(paneChange, moved('working', 'done', 'turn-finished'))
    paneChange({ ...moved('rest', 'working', 'prompt-submitted'), paneKey: 'tab-9:other' })
    await vi.advanceTimersByTimeAsync(AGENT_DONE_QUIET_MS)
    expect(seen.map((event) => event.kind)).toEqual(['turn-started'])
  })

  it('keeps the late watcher’s history and exact projection independent of phone policy', async () => {
    const h = await linked()
    const consumers = terminalConsumers(h)
    const capture = captureCandidates()
    try {
      const working = hookRow({
        worktreeId: WORKTREE,
        state: 'working',
        stateStartedAt: 100,
        turnStartedAt: 100,
        terminalHandle: 'term-1',
        connectionId: 'wsl',
        runId: 'run-1',
        executionId: 'execution-1',
        authorityRestartId: 'authority-1'
      })
      consumers.report(working)
      const seen: (ConversationSnapshot | ConversationEvent)[] = []
      const release = h.seam.watch(h.host, (event) => seen.push(event))
      const stamp300 = { ...working, turnCompletedAt: 300, receivedAt: 301 }
      consumers.report(stamp300)
      expect(seen.map((event) => event.kind)).toEqual(['snapshot'])
      expect(consumers.alerts).toHaveLength(1)
      expect(consumers.alerts[0].notificationId).toMatch(/:300$/)

      vi.advanceTimersByTime(6_000)
      consumers.report({ ...working, stateStartedAt: 400, turnStartedAt: 400, receivedAt: 401 })
      const stamp600 = {
        ...working,
        stateStartedAt: 400,
        turnStartedAt: 400,
        turnCompletedAt: 600,
        receivedAt: 601,
        lastAssistantMessage: 'Captured completion.'
      }
      consumers.report(stamp600)
      expect(seen.at(-1)).toMatchObject({
        kind: 'turn-ended',
        at: 600,
        lastAssistantMessage: 'Captured completion.'
      })
      expect(consumers.alerts).toHaveLength(2)
      expect(consumers.alerts[1].notificationId).toMatch(/:600$/)
      const paired = capture.observed.filter(({ candidate }) => candidate.originalRow === stamp600)
      expect(paired.map(({ connector }) => connector).sort()).toEqual([false, true])
      for (const { candidate } of paired) {
        expect(candidate.originalRow).toBe(stamp600)
        expect(candidate.snapshot).toMatchObject({
          state: 'done',
          stateStartedAt: 400,
          turnCompletedAt: 600,
          connectionId: 'wsl',
          terminalHandle: 'term-1',
          runId: 'run-1',
          executionId: 'execution-1',
          authorityRestartId: 'authority-1'
        })
      }
      consumers.report(stamp600)
      consumers.report({ ...stamp600, state: 'done', stateStartedAt: 700, receivedAt: 701 })
      await vi.advanceTimersByTimeAsync(AGENT_DONE_QUIET_MS)
      expect(seen.filter((event) => event.kind === 'turn-ended')).toHaveLength(1)
      expect(consumers.alerts).toHaveLength(2)

      consumers.policy.hasWindow = true
      consumers.report({ ...working, stateStartedAt: 800, turnStartedAt: 800, receivedAt: 801 })
      consumers.report({
        ...working,
        stateStartedAt: 800,
        turnStartedAt: 800,
        turnCompletedAt: 1_000,
        receivedAt: 1_001
      })
      expect(seen.at(-1)).toMatchObject({ kind: 'turn-ended', at: 1_000 })
      expect(consumers.alerts).toHaveLength(2)
      expect(
        capture.observed.filter(({ candidate }) => candidate.snapshot.turnCompletedAt === 1_000)
      ).toHaveLength(2)
      release()
    } finally {
      h.seam.dispose('connectors_disabled')
      consumers.dispose()
      capture.restore()
    }
  })

  it('admits the first own old-host finish after pre-watch work, but not a rest-first done', async () => {
    const h = await linked()
    const consumers = terminalConsumers(h)
    try {
      const working = hookRow({
        worktreeId: WORKTREE,
        connectionId: 'wsl',
        state: 'working',
        prompt: 'do task',
        stateStartedAt: 100,
        receivedAt: 101
      })
      consumers.report(working)
      const seen: (ConversationSnapshot | ConversationEvent)[] = []
      const release = h.seam.watch(h.host, (event) => seen.push(event))
      const done = {
        ...working,
        state: 'done' as const,
        stateStartedAt: 300,
        receivedAt: 301,
        lastAssistantMessage: 'Done.'
      }
      expect(done.turnEndDisposition).toBeUndefined()
      expect(done.turnCompletedAt).toBeUndefined()
      consumers.report(done)
      expect(consumers.changes.at(-1)).toMatchObject({
        kind: 'moved',
        from: 'working',
        to: 'done',
        transition: 'turn-finished'
      })
      expect(seen.at(-1)).toMatchObject({
        kind: 'turn-ended',
        at: 300,
        stopReason: null,
        lastAssistantMessage: 'Done.'
      })
      release()
      consumers.dispose()

      const control = terminalConsumers(h)
      // The host has no prior turn for this different pane: its first done stays rest.
      const controlPane = 'tab-2:22222222-2222-4222-8222-222222222222'
      h.put(WORKTREE, 'local', {
        externalConversations: [{ ...KEY, paneKey: controlPane, agent: 'claude', createdAt: 0 }]
      })
      const controlSeen: (ConversationSnapshot | ConversationEvent)[] = []
      const releaseControl = h.seam.watch(h.host, (event) => controlSeen.push(event))
      control.report({ ...done, paneKey: controlPane })
      expect(control.changes.filter((change) => change.paneKey === controlPane)).toEqual([
        expect.objectContaining({ kind: 'observed', phase: 'done' })
      ])
      await vi.advanceTimersByTimeAsync(AGENT_DONE_QUIET_MS)
      expect(controlSeen.map((event) => event.kind)).toEqual(['snapshot'])
      releaseControl()
      control.dispose()
    } finally {
      h.seam.dispose('connectors_disabled')
      consumers.dispose()
    }
  })

  it('tells a watcher of a conversation linked while it watches', async () => {
    const h = harness()
    const host = {
      launcher: fakeLauncher(async () => launchResult('handed-to-terminal')).launcher,
      terminal: fakeTerminal().terminal
    }
    const seen: (ConversationSnapshot | ConversationEvent)[] = []
    h.seam.watch(host, (event) => seen.push(event))
    await h.seam.start(host, KEY, 'd1', START)
    expect(seen).toEqual([
      { kind: 'snapshot', conversations: [] },
      { kind: 'linked', conversation: KEY, worktreeId: WORKTREE, paneKey: PANE, agent: 'claude' }
    ])
  })
})
