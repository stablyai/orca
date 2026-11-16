import { describe, expect, it } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { AGENT_LAUNCH_PERMISSION_CHOICE_CAPABILITY } from '../../../shared/agent-launch/contracts/agent-launch-runtime-capability'
import { seedWslHostAgentPermission, type WslHostPermissionSeed } from './wsl-host-permission-seed'
import type { WslOrcadHostCapabilityVerdict } from '../orcad/wsl-orcad-host-environments'

type HostPermission = { default: string; overrides: Record<string, string> } | undefined

function fakeHost(args: {
  permission: HostPermission
  verdict?: WslOrcadHostCapabilityVerdict
  failMutation?: boolean
}) {
  const calls: { method: string; params: unknown }[] = []
  const ok = (result: unknown): RuntimeRpcResponse<unknown> => ({
    id: 'req',
    ok: true,
    result,
    _meta: { runtimeId: 'wsl-runtime' }
  })
  const seed: Pick<WslHostPermissionSeed, 'call' | 'hostSupports'> = {
    hostSupports: async (capability) =>
      capability === AGENT_LAUNCH_PERMISSION_CHOICE_CAPABILITY
        ? (args.verdict ?? 'supported')
        : 'unsupported',
    call: async (method, params) => {
      calls.push({ method, params })
      if (method === 'settings.getAgentLaunch') {
        return ok({
          settings: {
            permissionMode: 'yolo',
            ...(args.permission ? { agentPermission: { ...args.permission, userArgs: {} } } : {})
          }
        })
      }
      if (args.failMutation) {
        return {
          id: 'req',
          ok: false,
          error: { code: 'runtime_error', message: 'write failed' },
          _meta: { runtimeId: 'wsl-runtime' }
        }
      }
      return ok({ settings: {} })
    }
  }
  const mutations = () =>
    calls.filter((call) => call.method === 'settings.mutateAgentLaunch').map((call) => call.params)
  return { seed, calls, mutations }
}

const UNTOUCHED: HostPermission = { default: 'full-access', overrides: {} }

describe('seedWslHostAgentPermission', () => {
  it('copies the local all-agents choice onto a host still at the product default', async () => {
    const host = fakeHost({ permission: UNTOUCHED })
    await expect(
      seedWslHostAgentPermission({ ...host.seed, local: { agentPermissionDefault: 'own' } })
    ).resolves.toBe(true)
    expect(host.mutations()).toEqual([{ type: 'permission', choice: 'own' }])
  })

  it('copies per-agent choices too', async () => {
    const host = fakeHost({ permission: UNTOUCHED })
    await seedWslHostAgentPermission({
      ...host.seed,
      local: { agentPermissionDefault: 'full-access', agentPermissionOverrides: { claude: 'ask' } }
    })
    expect(host.mutations()).toEqual([{ type: 'permission', choice: 'ask', agent: 'claude' }])
  })

  it('touches nothing when local is also at the product default', async () => {
    const host = fakeHost({ permission: UNTOUCHED })
    await expect(seedWslHostAgentPermission({ ...host.seed, local: {} })).resolves.toBe(false)
    expect(host.calls).toEqual([])
  })

  it('keeps a choice someone already made on the host', async () => {
    const chosen: HostPermission[] = [
      { default: 'ask', overrides: {} },
      { default: 'full-access', overrides: { codex: 'own' } }
    ]
    for (const permission of chosen) {
      const host = fakeHost({ permission })
      await expect(
        seedWslHostAgentPermission({ ...host.seed, local: { agentPermissionDefault: 'own' } })
      ).resolves.toBe(false)
      expect(host.mutations()).toEqual([])
    }
  })

  it('leaves older hosts alone', async () => {
    for (const verdict of ['unsupported', 'unknown'] as const) {
      const host = fakeHost({ permission: UNTOUCHED, verdict })
      await expect(
        seedWslHostAgentPermission({ ...host.seed, local: { agentPermissionDefault: 'own' } })
      ).resolves.toBe(false)
      expect(host.calls).toEqual([])
    }
    const textHost = fakeHost({ permission: undefined })
    await expect(
      seedWslHostAgentPermission({ ...textHost.seed, local: { agentPermissionDefault: 'own' } })
    ).resolves.toBe(false)
    expect(textHost.mutations()).toEqual([])
  })

  it('reports a failed write', async () => {
    const host = fakeHost({ permission: UNTOUCHED, failMutation: true })
    await expect(
      seedWslHostAgentPermission({ ...host.seed, local: { agentPermissionDefault: 'own' } })
    ).rejects.toThrow('write failed')
  })
})
