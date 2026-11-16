import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultWorkspaceSession } from '../../../../../shared/constants'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import {
  applyWorktreeSleepResumeRecords,
  captureWorktreeSleepResumeRecords
} from '../../../../runtime/terminal/stop/worktree-sleep-resume-records'
import { nativeChatTranscriptPathOnExecutionHost } from '../../../../native-chat/transcript-filesystem/ssh-transcript-path'
import { nativeChatTranscriptDistro } from '../../../../native-chat/transcript-discovery/native-chat-open-wake'
import { WSL_HOOK_RELAY_CONNECTION_PREFIX } from '../../../../../shared/agent-hook-listener/transport/wsl-hook-relay-contract'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { buildBody, ingestProgramStatusOsc, PANE, postHookEvent } from '../server.test-fixtures'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../../../../../shared/agent-status/process/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: vi.fn(async () => 'live')
}))

let home: string
let server: AgentHookServer
let stopping: boolean
let placed: boolean
let pty: { id: string; birth: string }
let saved: SleepingAgentSessionRecord | undefined
const read = () => server.getStatusSnapshotForPane(PANE)[0]

beforeEach(async () => {
  _internals.resetCachesForTests()
  home = mkdtempSync(join(tmpdir(), 'orca-sleep-status-'))
  stopping = false
  placed = true
  pty = { id: 'pty', birth: 'birth' }
  saved = undefined
  server = new AgentHookServer()
  const owns = (id: string, incarnation?: string) => id === pty.id && incarnation === pty.birth
  server.setTerminalPaneLifecycle({
    readSavedRecord: () => saved,
    ownsProcess: (_key, id, incarnation) => owns(id, incarnation),
    isStopping: () => stopping,
    isReversibleStop: (id, incarnation) => stopping && owns(id, incarnation),
    isPlaced: () => placed
  })
  await server.start({ env: 'production', userDataPath: home })
})

afterEach(() => {
  server.stop()
  vi.useRealTimers()
  rmSync(home, { recursive: true, force: true })
})

it.each(['claude', 'codex'] as const)(
  'keeps %s completion through sleep and restart, then retires it on close',
  async (agent) => {
    const hook = (event: string) =>
      postHookEvent(
        server,
        buildBody({
          hook_event_name: event,
          session_id: `${agent}-session`,
          prompt: 'Finished work'
        }),
        `/hook/${agent}`
      )
    await hook('UserPromptSubmit')
    await hook('Stop')
    expect(read()).toMatchObject({ state: 'done', agentType: agent })
    const before = read()
    stopping = true
    await hook('SessionEnd')
    server.reconcileEndedProcessForPaneKeys([PANE], { preserveResumeIdentity: true })
    expect(read()).toMatchObject({ state: 'done', prompt: 'Finished work' })
    const emitted = vi.fn()
    server.setListener(emitted)
    emitted.mockClear()
    expect(server.settleTerminalPaneSleep(PANE, 'pty', 'birth')).toBe(true)
    expect(read()).toMatchObject({
      state: 'done',
      receivedAt: before.receivedAt,
      stateStartedAt: before.stateStartedAt,
      paneSleep: { ptyId: 'pty', incarnationId: 'birth' }
    })
    expect(emitted.mock.calls.filter(([row]) => !row.isReplay)).toHaveLength(0)
    server.stop()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000)
    await server.start({ env: 'production', userDataPath: home })
    expect(read()).toMatchObject({ state: 'done', paneSleep: { ptyId: 'pty' } })
    server.retirePaneAuthority(PANE)
    expect(read()).toBeUndefined()
    server.stop()
    await server.start({ env: 'production', userDataPath: home })
    expect(read()).toBeUndefined()
  }
)

it('accepts a genuine providerless completion after stop intent and preserves it through transport loss', () => {
  const publish = (state: 'working' | 'done') =>
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: 'ssh-host',
      payload: { state, prompt: 'Custom task', agentType: 'unknown' }
    })
  publish('working')
  stopping = true
  publish('done')
  expect(server.settleTerminalPaneSleep(PANE, 'pty', 'other-birth')).toBe(false)
  expect(server.settleTerminalPaneSleep(PANE, 'pty', 'birth')).toBe(true)
  server.clearStatusEntriesForConnection('ssh-host')
  expect(read()).toMatchObject({ state: 'done', paneSleep: { ptyId: 'pty' } })
  server.retireSleepingPaneOnSpawn(PANE)
  expect(read()).toBeUndefined()
})

it.each(['idle Codex', 'Claude hook', 'failed resume', 'ordinary exit'] as const)(
  'keeps the correct saved session at the next sleep after %s',
  async (wake) => {
    const agent = wake === 'Claude hook' ? 'claude' : 'codex'
    const hook = async (event: string, pid: number) => {
      const response = await postHookEvent(
        server,
        buildBody(
          {
            hook_event_name: event,
            session_id: 'sleep-session',
            source: 'resume',
            prompt: 'Finished work'
          },
          {
            agentProcess: JSON.stringify({
              pid,
              platform: process.platform,
              startTime: `birth-${pid}`
            })
          }
        ),
        `/hook/${agent}`
      )
      expect(response.status).toBe(204)
    }
    await hook('UserPromptSubmit', 4001)
    await hook('Stop', 4001)
    const saved: SleepingAgentSessionRecord = {
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent,
      providerSession: { key: 'session_id', id: 'sleep-session' },
      prompt: 'Finished work',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep',
      restoreOnTabOpenOnly: true,
      connectionId: null
    }
    const session = {
      ...getDefaultWorkspaceSession(),
      sleepingAgentSessionsByPaneKey: { [PANE]: saved }
    }
    if (wake === 'ordinary exit') {
      server.reconcileEndedProcessForPaneKeys([PANE], {
        preserveResumeIdentity: true,
        endedPresence: { agent: 'codex', ended: true }
      })
    } else {
      stopping = true
      expect(server.settleTerminalPaneSleep(PANE, 'pty', 'birth')).toBe(true)
    }

    stopping = false
    server.retireSleepingPaneOnSpawn(
      PANE,
      wake === 'idle Codex' || wake === 'Claude hook'
        ? { agentType: agent, providerSession: { key: 'session_id', id: 'sleep-session' } }
        : undefined
    )
    if (wake === 'idle Codex' || wake === 'Claude hook') {
      server.recordLaunchResumeIdentity({
        paneKey: PANE,
        worktreeId: 'wt-1',
        agentType: agent,
        providerSession: { key: 'session_id', id: 'sleep-session' },
        launchedAt: Date.now()
      })
      expect(read()).toMatchObject({ state: 'done', prompt: 'Finished work' })
    }
    if (wake === 'Claude hook') {
      await hook('SessionStart', 4002)
      expect(await server.checkAgentPresenceSince(PANE, 0)).toBe('live')
    }
    const capture = await captureWorktreeSleepResumeRecords({
      worktreeId: 'wt-1',
      paneKeysByPtyId: new Map([['woken-pty', [PANE]]]),
      launchByPtyId: new Map(),
      readRowsForPane: (paneKey) => server.getStatusSnapshotForPane(paneKey),
      checkAgentPresence: (paneKey, since) => server.checkAgentPresenceSince(paneKey, since ?? 0),
      capturedAt: 2
    })
    const next = applyWorktreeSleepResumeRecords(session, capture, ['woken-pty']) ?? session
    if (wake === 'ordinary exit') {
      expect(next.sleepingAgentSessionsByPaneKey?.[PANE]).toBeUndefined()
    } else {
      expect(next.sleepingAgentSessionsByPaneKey?.[PANE]).toMatchObject({
        agent,
        providerSession: { key: 'session_id', id: 'sleep-session' },
        state: 'done',
        origin: 'worktree-sleep',
        restoreOnTabOpenOnly: true
      })
      if (wake === 'failed resume') {
        expect(read()).toBeUndefined()
        expect(next.sleepingAgentSessionsByPaneKey?.[PANE]).toEqual(saved)
      }
    }
  }
)

const agentHook = (agent: 'claude' | 'codex', event: string, pid: number, source = 'resume') =>
  postHookEvent(
    server,
    buildBody(
      { hook_event_name: event, session_id: `${agent}-session`, source, prompt: 'Finished work' },
      {
        agentProcess: JSON.stringify({ pid, platform: process.platform, startTime: `birth-${pid}` })
      }
    ),
    `/hook/${agent}`
  )

async function sleepPane(agent: 'claude' | 'codex', id: string, pid: number): Promise<void> {
  pty = { id, birth: `birth-${id}` }
  stopping = true
  if (agent === 'claude') {
    await agentHook(agent, 'SessionEnd', pid)
  }
  expect(server.settleTerminalPaneSleep(PANE, pty.id, pty.birth)).toBe(true)
  stopping = false
}

it.each(['claude', 'codex'] as const)(
  'keeps %s Done through sleep, idle wake and sleep again',
  async (agent) => {
    await agentHook(agent, 'UserPromptSubmit', 4001)
    await agentHook(agent, 'Stop', 4001)
    await sleepPane(agent, 'pty-1', 4001)
    server.retireSleepingPaneOnSpawn(PANE, {
      agentType: agent,
      providerSession: { key: 'session_id', id: `${agent}-session` }
    })
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      worktreeId: 'wt-1',
      agentType: agent,
      providerSession: { key: 'session_id', id: `${agent}-session` },
      launchedAt: Date.now()
    })
    if (agent === 'claude') {
      await agentHook(agent, 'SessionStart', 4002)
    }
    expect(read()).toMatchObject({ state: 'done', prompt: 'Finished work' })
    expect(read()).not.toHaveProperty('paneSleep')
    await sleepPane(agent, 'pty-2', 4002)
    expect(read()).toMatchObject({
      state: 'done',
      prompt: 'Finished work',
      paneSleep: { ptyId: 'pty-2' }
    })
  }
)

it.each(['claude', 'codex'] as const)(
  'keeps a mid-turn %s Interrupted through sleep, idle wake and sleep again',
  async (agent) => {
    await agentHook(agent, 'UserPromptSubmit', 4001)
    const emitted = vi.fn()
    server.setListener(emitted)
    emitted.mockClear()
    await sleepPane(agent, 'pty-1', 4001)
    expect(read()).toMatchObject({
      state: 'done',
      interrupted: true,
      prompt: 'Finished work',
      paneSleep: { ptyId: 'pty-1' }
    })
    expect(emitted.mock.calls.filter(([row]) => !row.isReplay)).toHaveLength(0)
    server.retireSleepingPaneOnSpawn(PANE, {
      agentType: agent,
      providerSession: { key: 'session_id', id: `${agent}-session` }
    })
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      worktreeId: 'wt-1',
      agentType: agent,
      providerSession: { key: 'session_id', id: `${agent}-session` },
      launchedAt: Date.now()
    })
    if (agent === 'claude') {
      await agentHook(agent, 'SessionStart', 4002)
    }
    expect(read()).toMatchObject({ state: 'done', interrupted: true })
    // Startup bytes restate the session before a new prompt; they do not finish another turn.
    for (const sessionBoundary of [true, undefined]) {
      server.ingestTerminalStatus({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'done', prompt: '', agentType: agent, sessionBoundary }
      })
      expect(read()).toMatchObject({ state: 'done', interrupted: true })
    }
    emitted.mockClear()
    await sleepPane(agent, 'pty-2', 4002)
    expect(read()).toMatchObject({
      state: 'done',
      interrupted: true,
      paneSleep: { ptyId: 'pty-2' }
    })
    expect(emitted.mock.calls.filter(([row]) => !row.isReplay)).toHaveLength(0)
  }
)

it.each(['retained', 'evicted'] as const)(
  'keeps Claude Interrupted through startup work before its verified root hook (%s row)',
  async (row) => {
    server.setHookRootEvidenceReader(async () => ({ verdict: 'root' }))
    await agentHook('claude', 'UserPromptSubmit', 4001)
    await sleepPane('claude', 'pty-1', 4001)
    for (const pid of [4002, 4003]) {
      const capture = await captureWorktreeSleepResumeRecords({
        worktreeId: 'wt-1',
        paneKeysByPtyId: new Map([[pty.id, [PANE]]]),
        launchByPtyId: new Map(),
        readRowsForPane: (paneKey) => server.getStatusSnapshotForPane(paneKey),
        checkAgentPresence: null,
        capturedAt: Date.now()
      })
      saved = capture.get(pty.id)!.records[0]!
      if (row === 'evicted') {
        server.dropStatusEntry(PANE, { preserveResumeIdentity: false })
      }
      server.retireSleepingPaneOnSpawn(PANE, {
        agentType: 'claude',
        providerSession: { key: 'session_id', id: 'claude-session' }
      })
      server.recordLaunchResumeIdentity({
        paneKey: PANE,
        worktreeId: 'wt-1',
        agentType: 'claude',
        providerSession: { key: 'session_id', id: 'claude-session' },
        launchedAt: Date.now()
      })
      // Startup work precedes SessionStart; neither report opens a user turn.
      for (const state of ['working', 'idle']) {
        ingestProgramStatusOsc(server, `\x1b]7501;app=claude-code:state=${state}\x1b\\`)
        expect(read()).toMatchObject({
          state: 'done',
          interrupted: true,
          prompt: 'Finished work',
          mainAgent: { state: 'done', outcome: 'cancellation' }
        })
      }
      const response = await postHookEvent(
        server,
        buildBody(
          { hook_event_name: 'SessionStart', session_id: 'claude-session', source: 'resume' },
          {
            launchToken: `wake-${pid}`,
            agentProcess: JSON.stringify({
              pid,
              platform: process.platform,
              startTime: `birth-${pid}`
            })
          }
        )
      )
      expect(response.status).toBe(204)
      expect(read()).toMatchObject({
        state: 'done',
        interrupted: true,
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
      await sleepPane('claude', `pty-${pid}`, pid)
      expect(read()).toMatchObject({ state: 'done', interrupted: true })
    }
    server.retireSleepingPaneOnSpawn(PANE, {
      agentType: 'claude',
      providerSession: { key: 'session_id', id: 'claude-session' }
    })
    await agentHook('claude', 'UserPromptSubmit', 4004)
    expect(read()).toMatchObject({ state: 'working', prompt: 'Finished work' })
    expect(read()?.interrupted).not.toBe(true)
    await agentHook('claude', 'Stop', 4004)
    expect(read()).toMatchObject({ state: 'done' })
    expect(read()?.interrupted).not.toBe(true)
  }
)

it.each(['claude', 'codex'] as const)(
  'keeps a %s that never had a turn through sleep',
  async (agent) => {
    if (agent === 'claude') {
      await agentHook(agent, 'SessionStart', 4001, 'startup')
    } else {
      server.recordLaunchResumeIdentity({
        paneKey: PANE,
        worktreeId: 'wt-1',
        agentType: agent,
        providerSession: { key: 'session_id', id: `${agent}-session` },
        launchedAt: Date.now()
      })
    }
    await sleepPane(agent, 'pty-1', 4001)
    expect(server.paneAgentIdentity(PANE)).toMatchObject({
      status: {
        agentType: agent,
        state: 'done',
        sessionBoundary: true,
        paneSleep: { ptyId: 'pty-1' }
      },
      ended: false
    })
  }
)

it('does not restore a sleeping status whose exact placed pane is absent', async () => {
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    payload: { state: 'done', prompt: 'Custom task', agentType: 'unknown' }
  })
  stopping = true
  expect(server.settleTerminalPaneSleep(PANE, 'pty', 'birth')).toBe(true)
  server.stop()
  placed = false
  await server.start({ env: 'production', userDataPath: home })
  expect(read()).toBeUndefined()
})

it('keeps transcript host evidence indexed through replacement, sleep and close', () => {
  const publish = (id: string, connectionId: string) =>
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        providerSession: { key: 'session_id', id, transcriptPath: '/home/user/session.jsonl' },
        payload: { state: 'done', prompt: 'Finished', agentType: 'claude' }
      },
      connectionId
    )
  publish('first-session', 'ssh-1')
  const initial = server.getProviderSessionSourceRowsForSessionId('first-session')
  expect(initial).toHaveLength(1)
  expect(
    nativeChatTranscriptPathOnExecutionHost(initial, 'first-session', '/home/user/session.jsonl')
  ).toBe('orca-ssh-transcript:ssh-1:/home/user/session.jsonl')
  publish('second-session', `${WSL_HOOK_RELAY_CONNECTION_PREFIX}Ubuntu`)
  expect(server.getProviderSessionSourceRowsForSessionId('first-session')).toEqual([])
  const replacement = server.getProviderSessionSourceRowsForSessionId('second-session')
  expect(replacement).toHaveLength(1)
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  try {
    expect(nativeChatTranscriptDistro(replacement, 'second-session', undefined)).toBe('Ubuntu')
  } finally {
    platform.mockRestore()
  }
  stopping = true
  expect(server.settleTerminalPaneSleep(PANE, 'pty', 'birth')).toBe(true)
  expect(server.getProviderSessionSourceRowsForSessionId('second-session')).toHaveLength(1)
  server.retirePaneAuthority(PANE)
  expect(server.getProviderSessionSourceRowsForSessionId('second-session')).toEqual([])
})
