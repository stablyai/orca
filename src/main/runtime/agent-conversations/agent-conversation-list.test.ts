import { expect, it, vi } from 'vitest'
import { agentConversationPlaces } from './agent-conversation-list'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'

const TERMINAL = testOrcaSessionId('claude_5688af50_12a0_4b0b_9a4a_098d87fe1e68')
const hookServer = vi.hoisted(() => ({
  terminalAgentPlaces: vi.fn(),
  getPublicStatusSnapshotForPane: vi.fn()
}))
vi.mock('../../agent-hooks/server/agent-hook-server', () => ({ agentHookServer: hookServer }))

function status(paneKey: string, orcaSessionId: string) {
  return {
    paneKey,
    worktreeId: 'repo::/workspace',
    orcaSessionId,
    agentType: 'claude',
    state: 'working',
    receivedAt: 5
  }
}

it.each([750, 7_500])(
  'shows one agent from its own panes, whatever the other %i panes run',
  async (unrelatedPanes) => {
    const panes = ['tab-a:1', 'tab-b:1']
    hookServer.terminalAgentPlaces.mockResolvedValue(panes.map((paneKey) => ({ paneKey })))
    hookServer.getPublicStatusSnapshotForPane.mockReset()
    const rows = new Map(
      Array.from({ length: unrelatedPanes }, (_, index) => [
        `tab-${index}:1`,
        [status(`tab-${index}:1`, `claude_other_${index}`)]
      ])
    )
    for (const paneKey of panes) {
      rows.set(paneKey, [status(paneKey, TERMINAL)])
    }
    hookServer.getPublicStatusSnapshotForPane.mockImplementation(
      (paneKey: string) => rows.get(paneKey) ?? []
    )
    const runtime = {
      getWorkspaceLabel: vi.fn(() => ({ workspace: 'Workspace', repo: 'repo' })),
      getWorktreePs: vi.fn()
    }

    const places = await agentConversationPlaces(runtime, {
      kind: 'terminal',
      orcaSessionId: TERMINAL
    })

    expect(places.map((place) => place.paneKey)).toEqual(panes)
    expect(places[0]).toMatchObject({
      workspace: 'Workspace',
      repo: 'repo',
      state: 'working',
      kind: 'terminal'
    })
    expect(hookServer.getPublicStatusSnapshotForPane).toHaveBeenCalledTimes(2)
    expect(runtime.getWorkspaceLabel).toHaveBeenCalledTimes(2)
    expect(runtime.getWorktreePs).not.toHaveBeenCalled()
  }
)
