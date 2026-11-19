import { expect, it, vi } from 'vitest'
import { PANE } from '../server.test-fixtures'
import {
  NOW,
  TMUX,
  TMUX_HINT,
  codexTurn,
  createServer,
  hook,
  io,
  registerRootTestHarness,
  runningPane,
  type Proc,
  type RootTestServer
} from './server-tmux-hook-root.test-fixtures'
import {
  AgentStatusObservedPaneIdentities,
  AgentStatusObservedPaneIdentityCapture
} from '../../../../runtime/terminal/identity/agent-status-observed-pane-identity'
import { readHookRootEvidence } from '../../../../../shared/agent-hook-listener/presence/hook-process-root-evidence'
import { readPaneTmuxHost } from '../../../../../shared/agent-hook-listener/presence/pane-tmux-host-proof'
import { captureWorktreeSleepResumeRecords } from '../../../../runtime/terminal/stop/worktree-sleep-resume-records'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../../../../../shared/agent-status/process/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: vi.fn()
}))

registerRootTestHarness()

// The pane shows the tmux session through its foreground client.
const CLIENT: Proc = [4050, 101, 4050, 'tmux -L qa attach', 'S+']

it.each([
  [
    'claude',
    (server: RootTestServer) =>
      hook(server, 'UserPromptSubmit', {
        session: 'tmux',
        pid: 4043,
        tmuxPane: TMUX_HINT,
        prompt: 'In tmux'
      })
  ],
  ['codex', (server: RootTestServer) => codexTurn(server)]
] as const)(
  'does not capture a legacy %s whose tmux server outlives the sleeping pane',
  async (_agent, turn) => {
    const server = await createServer()
    server.setHookRootEvidenceReader(
      (request) => readHookRootEvidence(request, io),
      (request) => readPaneTmuxHost(io, request)
    )
    const identities = new AgentStatusObservedPaneIdentities()
    const observed = new AgentStatusObservedPaneIdentityCapture(identities)
    const runtime = {
      getAgentStatusTerminalHandleForPaneKey: () => 'terminal-a',
      getTerminalProcessIncarnation: () => 'execution-a',
      getAgentStatusOrchestrationContextForPaneKey: () => undefined
    }
    observed.attach(runtime)
    server.subscribeEnrichedStatus((row) => observed.observe(row))
    server.setCliWriterExecutionMatcher(identities, runtime)
    runningPane(4050, CLIENT, ...TMUX)
    await turn(server)
    expect(server.row()).toMatchObject({ state: 'working', providerSession: {} })
    await server.checkAgentPresenceSince(PANE, 0, { sleepCapture: true })
    // A fresh hook can land between capture's presence check and the PTY's physical stop.
    await turn(server)
    server.setTerminalPaneLifecycle({
      ownsProcess: () => true,
      isStopping: () => true,
      isReversibleStop: () => true,
      isPlaced: () => true
    })
    expect(server.settleTerminalPaneSleep(PANE, 'pty')).toBe(true)
    expect(server.row()).toMatchObject({ state: 'working' })
    const capture = await captureWorktreeSleepResumeRecords({
      worktreeId: 'wt-1',
      paneKeysByPtyId: new Map([['pty', [PANE]]]),
      launchByPtyId: new Map(),
      readRowsForPane: (key) => server.getStatusSnapshotForPane(key),
      readIdentity: (key, saved) => server.paneAgentIdentity(key, saved),
      checkAgentPresence: (key, since) =>
        server.checkAgentPresenceSince(key, since ?? 0, { sleepCapture: true }),
      capturedAt: NOW
    })
    expect(capture.get('pty')).toEqual({ records: [], retiredPaneKeys: [PANE] })
    // Provider cleanup keeps the row; the runtime's second exit settlement sees the same owner.
    expect(server.settleTerminalPaneSleep(PANE, 'pty')).toBe(true)
    expect(server.row()).toMatchObject({ state: 'working' })
    expect(server.row()?.interrupted).not.toBe(true)
    server.retireSleepingPaneOnSpawn(PANE)
    expect(server.row()).toBeUndefined()
  }
)

it('does not recapture a detached tmux writer from its remaining live checkpoint', async () => {
  const server = await createServer()
  server.setHookRootEvidenceReader(
    (request) => readHookRootEvidence(request, io),
    (request) => readPaneTmuxHost(io, request)
  )
  const identities = new AgentStatusObservedPaneIdentities()
  const observed = new AgentStatusObservedPaneIdentityCapture(identities)
  const runtime = {
    getAgentStatusTerminalHandleForPaneKey: () => 'terminal-a',
    getTerminalProcessIncarnation: () => 'execution-a',
    getAgentStatusOrchestrationContextForPaneKey: () => undefined
  }
  observed.attach(runtime)
  server.subscribeEnrichedStatus((row) => observed.observe(row))
  server.setCliWriterExecutionMatcher(identities, runtime)
  runningPane(4050, CLIENT, ...TMUX)
  await hook(server, 'UserPromptSubmit', {
    session: 'detached-session',
    pid: 4043,
    tmuxPane: TMUX_HINT,
    prompt: 'In tmux'
  })
  // Nothing probes the pane while the client is attached; only the hook says it ran in tmux.
  let saved: SleepingAgentSessionRecord | undefined = {
    paneKey: PANE,
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'detached-session' },
    prompt: 'In tmux',
    state: 'done',
    capturedAt: NOW,
    updatedAt: NOW,
    origin: 'live'
  }
  let stopping = false
  server.setTerminalPaneLifecycle({
    ownsProcess: () => true,
    isStopping: () => stopping,
    isReversibleStop: () => true,
    isPlaced: () => true,
    readSavedRecord: () => saved,
    retireSavedRecord: () => {
      saved = undefined
    }
  })
  // Detach ends the outer command, while the original agent remains under its server.
  runningPane(101, ...TMUX)
  // The tmux client's command finished after an earlier finish retired the launch: no exit named.
  server.retireProcessAuthority(PANE, { confirmedExit: false })
  expect(saved).toBeUndefined()
  expect(server.row()).toBeUndefined()
  // The sleep's physical stop must not promote a stale checkpoint into a pane-owned agent.
  stopping = true
  expect(server.settleTerminalPaneSleep(PANE, 'pty')).toBe(false)
  const capture = await captureWorktreeSleepResumeRecords({
    worktreeId: 'wt-1',
    paneKeysByPtyId: new Map([['pty', [PANE]]]),
    launchByPtyId: new Map(),
    readRowsForPane: (key) => server.getStatusSnapshotForPane(key),
    readSavedRecord: async () => saved,
    readIdentity: (key, record) => server.paneAgentIdentity(key, record),
    checkAgentPresence: (key, since) =>
      server.checkAgentPresenceSince(key, since ?? 0, { sleepCapture: true }),
    capturedAt: NOW + 1_000
  })
  expect(capture.get('pty')?.records).toEqual([])
})

it('does not resume a checkpoint the pane reaches through its tmux client after a restart', async () => {
  // A restart forgot the tmux row; the client still shows the agent before it hooks again.
  const server = await createServer()
  server.setHookRootEvidenceReader(
    (request) => readHookRootEvidence(request, io),
    (request) => readPaneTmuxHost(io, request)
  )
  runningPane(4050, CLIENT, ...TMUX)
  let saved: SleepingAgentSessionRecord | undefined = {
    paneKey: PANE,
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'restarted-session' },
    prompt: 'In tmux',
    state: 'done',
    capturedAt: NOW,
    updatedAt: NOW,
    origin: 'live'
  }
  server.setTerminalPaneLifecycle({
    ownsProcess: () => true,
    isStopping: () => false,
    isReversibleStop: () => true,
    isPlaced: () => true,
    readSavedRecord: () => saved,
    retireSavedRecord: () => {
      saved = undefined
    }
  })
  // Ordinary presence reads (fleet status) don't pay for the tmux probe.
  await server.checkAgentPresenceSince(PANE, 0)
  expect(saved).toBeDefined()
  const capture = await captureWorktreeSleepResumeRecords({
    worktreeId: 'wt-1',
    paneKeysByPtyId: new Map([['pty', [PANE]]]),
    launchByPtyId: new Map(),
    readRowsForPane: (key) => server.getStatusSnapshotForPane(key),
    readSavedRecord: async () => saved,
    readIdentity: (key, record) => server.paneAgentIdentity(key, record),
    checkAgentPresence: (key, since) =>
      server.checkAgentPresenceSince(key, since ?? 0, { sleepCapture: true }),
    capturedAt: NOW + 1_000
  })
  expect(saved).toBeUndefined()
  expect(capture.get('pty')?.records).toEqual([])
})

it('proves a tmux-hosted pane only from a complete process picture', async () => {
  const pane = { paneKey: PANE, worktreeId: 'wt-1' }
  const agent = { ...pane, process: { pid: 4043, platform: 'darwin', startTime: 'start' } as const }
  runningPane(4050, CLIENT, ...TMUX)
  await expect(readPaneTmuxHost(io, pane)).resolves.toBe(true)
  await expect(readPaneTmuxHost(io, agent)).resolves.toBe(true)
  // The pane's own suspended agent stays behind an unrelated tmux client; other jobs don't matter.
  runningPane(4050, CLIENT, [4060, 101, 4060, 'claude', 'T'], ...TMUX)
  await expect(readPaneTmuxHost(io, pane)).resolves.toBe(false)
  runningPane(4050, CLIENT, [4070, 101, 4070, 'sleep 9999'], ...TMUX)
  await expect(readPaneTmuxHost(io, pane)).resolves.toBe(true)
  // An unreadable job might be the pane's own agent.
  runningPane(4050, CLIENT, [4080, 101, 4080, '(claude)', 'T'], ...TMUX)
  await expect(readPaneTmuxHost(io, pane)).resolves.toBe(false)
  // tmux resolves an unambiguous prefix, so `att` attaches.
  runningPane(4050, [4050, 101, 4050, 'tmux -L qa att -t cl', 'S+'], ...TMUX)
  await expect(readPaneTmuxHost(io, pane)).resolves.toBe(true)
  // Grouped flags: `-vc new` runs a shell command, while `-Lc` names a socket.
  runningPane(4050, [4050, 101, 4050, 'tmux -vc new', 'S+'], ...TMUX)
  await expect(readPaneTmuxHost(io, pane)).resolves.toBe(false)
  runningPane(4050, [4050, 101, 4050, 'tmux -DL qa', 'S+'], ...TMUX)
  await expect(readPaneTmuxHost(io, pane)).resolves.toBe(false)
  runningPane(4050, [4050, 101, 4050, 'tmux -VL qa', 'S+'], ...TMUX)
  await expect(readPaneTmuxHost(io, pane)).resolves.toBe(false)
  runningPane(4050, [4050, 101, 4050, 'tmux -Lc attach', 'S+'], ...TMUX)
  await expect(readPaneTmuxHost(io, pane)).resolves.toBe(true)
  // A foreground tmux command that attaches no session hosts nothing.
  runningPane(4050, [4050, 101, 4050, 'tmux wait-for build-ready', 'S+'], ...TMUX)
  await expect(readPaneTmuxHost(io, pane)).resolves.toBe(false)
  // An agent whose ancestry cannot be read is not proven to live outside the pane.
  runningPane(4050, CLIENT, [4043, 4042, 4043, 'claude', 'S+', 'ttys011'])
  await expect(readPaneTmuxHost(io, agent)).resolves.toBe(false)
})

it('keeps a checkpoint saved while its tmux release was probing', async () => {
  const server = await createServer()
  const record = (id: string, updatedAt: number): SleepingAgentSessionRecord => ({
    paneKey: PANE,
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id },
    prompt: 'In tmux',
    state: 'done',
    capturedAt: updatedAt,
    updatedAt,
    origin: 'live'
  })
  // Saved after the probe began, with the same clock as the record it replaces.
  const replacement = record('replacement', NOW)
  let saved: SleepingAgentSessionRecord | undefined = record('released', NOW)
  server.setHookRootEvidenceReader(
    (request) => readHookRootEvidence(request, io),
    (request) => {
      saved = replacement
      return readPaneTmuxHost(io, request)
    }
  )
  runningPane(4050, CLIENT, ...TMUX)
  server.setTerminalPaneLifecycle({
    ownsProcess: () => true,
    isStopping: () => false,
    isReversibleStop: () => true,
    isPlaced: () => true,
    readSavedRecord: () => saved,
    retireSavedRecord: (_paneKey, before) => {
      if (saved && saved.updatedAt <= before) {
        saved = undefined
      }
    }
  })
  vi.setSystemTime(NOW + 1_000)
  await server.checkAgentPresenceSince(PANE, 0, { sleepCapture: true })
  expect(saved).toBe(replacement)
})
