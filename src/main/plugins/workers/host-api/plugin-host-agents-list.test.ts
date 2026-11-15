import { describe, expect, it, vi } from 'vitest'
import { callPluginHost, pluginHostTestServices } from './__mocks__/plugin-host-services-fixture'

describe('agents.list for a named workspace', () => {
  it('resolves the workspace through the runtime and lists only its agents', async () => {
    const runtimeRpc = vi.fn().mockResolvedValue({ worktree: { id: 'wt-1::/repo' } })
    const resolveActiveWorktreeContext = vi.fn().mockResolvedValue(null)
    const services = pluginHostTestServices(runtimeRpc, {
      resolveActiveWorktreeContext,
      listWorktreeTerminals: vi.fn().mockResolvedValue([{ id: 't1', title: 'Claude' }]),
      listAgentStatuses: () => [
        {
          paneKey: 'tab-1:leaf-1',
          worktreeId: 'wt-1::/repo',
          terminalHandle: 't1',
          state: 'blocked',
          agentType: 'claude',
          stateStartedAt: 10
        },
        {
          paneKey: 'tab-2:leaf-2',
          worktreeId: 'wt-2::/other',
          terminalHandle: 't2',
          state: 'working',
          agentType: 'codex',
          stateStartedAt: 20
        }
      ]
    })

    const outcome = await callPluginHost({
      method: 'agents.list',
      params: { workspaceId: 'identity:wt2:local:abc' },
      granted: ['agent:read'],
      services
    })

    expect(runtimeRpc).toHaveBeenCalledWith(
      'worktree.show',
      { worktree: 'identity:wt2:local:abc', matchFolderWorkspaces: true },
      {}
    )
    expect(resolveActiveWorktreeContext).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({
      ok: true,
      value: {
        agents: [
          {
            terminalId: 't1',
            title: 'Claude',
            agent: 'claude',
            state: 'blocked',
            stateStartedAt: 10
          }
        ]
      }
    })
  })

  it.each([
    ['selector_not_found', 'action_failed', 'no workspace has this id'],
    // Why not action_failed: the param is 1.10, after the runtime failure codes (1.7).
    ['client_disconnected', 'unavailable', 'the host that owns this is not connected']
  ])('refuses a workspace the runtime answers %s for', async (runtimeCode, code, error) => {
    const refusal = Object.assign(new Error(runtimeCode), { code: runtimeCode })
    const services = pluginHostTestServices(vi.fn().mockRejectedValue(refusal), {
      listAgentStatuses: () => []
    })

    const outcome = await callPluginHost({
      method: 'agents.list',
      params: { workspaceId: 'identity:gone' },
      granted: ['agent:read'],
      services
    })

    expect(outcome).toEqual({ ok: false, code, error })
  })
})
