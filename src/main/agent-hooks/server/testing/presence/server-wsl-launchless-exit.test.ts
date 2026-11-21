import { expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hook-server'
import { wslHookRelayConnectionId } from '../../../../../shared/agent-hook-listener/transport/wsl-hook-relay-contract'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const PANE = 'tab-wsl:44444444-4444-4444-8444-444444444444'

it("ends a typed WSL agent at its shell's mark, though it reported a PID main can't probe", async () => {
  const server = new AgentHookServer()
  const worktreeId = String.raw`repo::\\wsl.localhost\Ubuntu\home\user\repo`
  server.ingestRemote(
    {
      paneKey: PANE,
      tabId: 'tab-wsl',
      worktreeId,
      providerSession: { key: 'session_id', id: 'wsl-claude' },
      agentPresence: {
        agent: 'claude',
        sessionOwner: true,
        process: { pid: 4001, platform: 'linux', startTime: 'boot:4001' }
      },
      payload: { state: 'done', prompt: 'ship it', agentType: 'claude' }
    },
    wslHookRelayConnectionId('Ubuntu')
  )
  server.setTerminalPaneLifecycle({
    ownsProcess: () => true,
    isStopping: () => false,
    isReversibleStop: () => false,
    isPlaced: () => true,
    confirmShellAlone: async () => null
  })
  expect(server.paneAgentIdentity(PANE)?.ended).toBe(false)
  server.retireProcessAuthority(PANE, { confirmedExit: true, launchRetired: true })
  await new Promise((resolve) => setImmediate(resolve))
  expect(server.paneAgentIdentity(PANE)?.ended ?? true).toBe(true)
})
