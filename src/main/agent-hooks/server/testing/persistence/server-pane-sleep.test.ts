import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeChatTranscriptPathOnExecutionHost } from '../../../../native-chat/ssh-transcript-path'
import { nativeChatTranscriptDistro } from '../../../../native-chat/native-chat-open-wake'
import { WSL_HOOK_RELAY_CONNECTION_PREFIX } from '../../../../../shared/wsl-hook-relay-contract'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { buildBody, PANE, postHookEvent } from '../server.test-fixtures'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

let home: string
let server: AgentHookServer
let stopping: boolean
let placed: boolean
const read = () => server.getStatusSnapshotForPane(PANE)[0]

beforeEach(async () => {
  _internals.resetCachesForTests()
  home = mkdtempSync(join(tmpdir(), 'orca-sleep-status-'))
  stopping = false
  placed = true
  server = new AgentHookServer()
  server.setTerminalPaneLifecycle({
    ownsProcess: (_key, pty, incarnation) => pty === 'pty' && incarnation === 'birth',
    isStopping: () => stopping,
    isReversibleStop: (pty, incarnation) => stopping && pty === 'pty' && incarnation === 'birth',
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
  expect(server.settleTerminalPaneSleep(PANE, 'pty', 'birth')).toBe(false)
  publish('done')
  expect(server.settleTerminalPaneSleep(PANE, 'pty', 'other-birth')).toBe(false)
  expect(server.settleTerminalPaneSleep(PANE, 'pty', 'birth')).toBe(true)
  server.clearStatusEntriesForConnection('ssh-host')
  expect(read()).toMatchObject({ state: 'done', paneSleep: { ptyId: 'pty' } })
  server.retireSleepingPaneOnSpawn(PANE)
  expect(read()).toBeUndefined()
})

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
