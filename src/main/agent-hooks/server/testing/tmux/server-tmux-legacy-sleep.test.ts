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
} from '../presence/server-hook-root.test-fixtures'
import {
  readHookRootEvidence,
  readPaneTmuxHost
} from '../../../../../shared/agent-hook-listener/presence/hook-process-root-evidence'
import { captureWorktreeSleepResumeRecords } from '../../../../runtime/terminal/stop/worktree-sleep-resume-records'

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
    runningPane(4050, CLIENT, ...TMUX)
    await turn(server)
    expect(server.row()).toMatchObject({ state: 'working', providerSession: {} })
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
  }
)
