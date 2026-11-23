import { describe, expect, it } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { AGENT_LAUNCH_PERMISSION_SEED_CAPABILITY } from '../../../shared/agent-launch/contracts/agent-launch-runtime-capability'
import { AgentLaunchSettingsMutation } from '../../../shared/rpc-contract/agent-launch/agent-launch-settings-params'
import { seedWslHostAgentPermission, type WslHostPermissionSeed } from './wsl-host-permission-seed'
import type { WslOrcadHostCapabilityVerdict } from '../orcad/wsl-orcad-host-environments'

function fakeHost(verdict: WslOrcadHostCapabilityVerdict = 'supported', fail = false) {
  const calls: { method: string; params: unknown }[] = []
  const seed: Pick<WslHostPermissionSeed, 'call' | 'hostSupports'> = {
    hostSupports: async (capability) =>
      capability === AGENT_LAUNCH_PERMISSION_SEED_CAPABILITY ? verdict : 'unsupported',
    call: async (method, params): Promise<RuntimeRpcResponse<unknown>> => {
      calls.push({ method, params })
      return fail
        ? {
            id: 'req',
            ok: false,
            error: { code: 'runtime_error', message: 'write failed' },
            _meta: { runtimeId: 'wsl-runtime' }
          }
        : { id: 'req', ok: true, result: { settings: {} }, _meta: { runtimeId: 'wsl-runtime' } }
    }
  }
  return { seed, calls }
}

describe('seedWslHostAgentPermission', () => {
  it('sends one conditional write the host contract accepts, never a read-then-write', async () => {
    const host = fakeHost()
    await expect(
      seedWslHostAgentPermission({
        ...host.seed,
        local: { agentPermissionDefault: 'own', agentPermissionOverrides: { claude: 'ask' } }
      })
    ).resolves.toBe(true)
    expect(host.calls).toEqual([
      {
        method: 'settings.mutateAgentLaunch',
        params: { type: 'seed-permission', choice: 'own', overrides: { claude: 'ask' } }
      }
    ])
    expect(AgentLaunchSettingsMutation.safeParse(host.calls[0].params).success).toBe(true)
  })

  it('leaves hosts without the conditional write alone', async () => {
    for (const verdict of ['unsupported', 'unknown'] as const) {
      const host = fakeHost(verdict)
      await expect(
        seedWslHostAgentPermission({ ...host.seed, local: { agentPermissionDefault: 'own' } })
      ).resolves.toBe(false)
      expect(host.calls).toEqual([])
    }
  })
})
