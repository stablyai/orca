import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PANE } from '../server.test-fixtures'
import {
  NOW,
  TMUX,
  TMUX_HINT,
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
import { captureWorktreeSleepResumeRecords } from '../../../../runtime/terminal/stop/worktree-sleep-resume-records'
import { resumeStatusFromHookRow } from '../../../../runtime/terminal/stop/hook-status-resume-records'
import { liveResumeRecord } from '../../../../../shared/agent-session/lifecycle/resume/agent-resume-record-from-status'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../../../../../shared/agent-status/process/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: vi.fn()
}))

registerRootTestHarness()

// The pane shows the tmux session through its foreground client.
const CLIENT: Proc = [4050, 101, 4050, 'tmux -L qa attach', 'S+']

// A pane the runtime places, so the hook's binding keeps the topology it reported.
async function placedServer(userDataPath?: string): Promise<RootTestServer> {
  const server = await createServer(userDataPath)
  server.setHookRootEvidenceReader((request) => readHookRootEvidence(request, io))
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
  return server
}

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
  [
    'codex',
    (server: RootTestServer) =>
      hook(server, 'UserPromptSubmit', {
        session: 'cx',
        pid: null,
        prompt: 'task',
        source: 'codex',
        tmuxPane: TMUX_HINT
      })
  ]
] as const)(
  'does not capture a %s whose tmux server outlives the sleeping pane',
  async (_agent, turn) => {
    const server = await placedServer()
    runningPane(4050, CLIENT, ...TMUX)
    await turn(server)
    expect(server.row()).toMatchObject({ state: 'working', providerSession: {} })
    await server.checkAgentPresenceSince(PANE, 0)
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
      checkAgentPresence: (key, since) => server.checkAgentPresenceSince(key, since ?? 0),
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

it('leaves a tmux-hosted conversation no checkpoint, before or after a restart', async () => {
  const checkpointOf = (server: RootTestServer) => {
    const row = server.row()
    const status = row && resumeStatusFromHookRow(row, undefined)
    return status
      ? liveResumeRecord({
          entry: status,
          retainsResumableIdentity: false,
          worktreeIdOf: () => 'wt-1',
          tabOf: () => undefined,
          capturedAt: NOW
        })
      : null
  }
  const runIn = async (userDataPath: string, tmuxPane?: string) => {
    const server = await placedServer(userDataPath)
    await hook(server, 'UserPromptSubmit', {
      session: 'detached-session',
      pid: 4043,
      prompt: 'In tmux',
      ...(tmuxPane ? { tmuxPane } : {})
    })
    const before = checkpointOf(server)
    server.flushStatusPersistSync()
    server.stop()
    // A restart hydrates the row; the agent still runs (in tmux, detached or not).
    const restarted = await createServer(userDataPath)
    const after = restarted.row() && checkpointOf(restarted)
    restarted.stop()
    return [before, after]
  }
  expect(await runIn(mkdtempSync(join(tmpdir(), 'orca-pane-')))).toEqual([
    expect.objectContaining({ origin: 'live' }),
    expect.objectContaining({ origin: 'live' })
  ])
  expect(await runIn(mkdtempSync(join(tmpdir(), 'orca-tmux-')), TMUX_HINT)).toEqual([null, null])
})
