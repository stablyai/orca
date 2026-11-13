// PAIRED-HELD-STRIPS: a paired-from-birth Orca Cloud workspace (no local runtime record, only its
// pairing binding) resolves in every main-side lookup keyed by its runtime environment: the D13
// workspace Sources read, setting a workspace source, and the cloud secrets calls.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => {
  const state: { list: string[] } = { list: [] }
  return state
})
const handlers = vi.hoisted(() => new Map<string, (event: unknown, raw: unknown) => unknown>())

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/u' },
  shell: { openExternal: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => unknown) => {
      handlers.set(channel, fn)
    },
    removeHandler: (channel: string) => handlers.delete(channel)
  }
}))
vi.mock('../../shared/ephemeral-vm-runtime-store', () => ({ listEphemeralVmRuntimes: () => [] }))
vi.mock('./hosted-sandbox-config', () => ({
  getHostedSandboxConfig: () => ({ controlPlaneUrl: 'https://cp.test' })
}))
vi.mock('../orca-cloud-agents/orca-cloud-agents-service', () => ({
  createOrcaCloudAgentsService: () => ({
    workspaceSources: async (workspaceId: string) => {
      calls.list.push(`sources:${workspaceId}`)
      return { ok: true, value: {} }
    },
    setWorkspaceSource: async (_agent: string, _source: string, workspaceId: string) => {
      calls.list.push(`setSource:${workspaceId}`)
      return { ok: true, value: {} }
    }
  })
}))
vi.mock('../cloud-secrets/cloud-secrets-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createCloudSecretsClient: () => ({
    workspaceSharing: async (sandboxId: string) => {
      calls.list.push(`sharing:${sandboxId}`)
      return {}
    },
    refreshEnv: async (sandboxId: string) => {
      calls.list.push(`refresh:${sandboxId}`)
      return {}
    }
  })
}))

const { noteCloudPairingBindings } =
  await import('../cloud-workspaces/cloud-paired-environment-ids')
const { registerOrcaCloudAgentsHandlers } =
  await import('../orca-cloud-agents/orca-cloud-agents-ipc')
const { registerCloudSecretsHandlers } = await import('../cloud-secrets/cloud-secrets-ipc')

const call = (channel: string, raw: unknown) => {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`no handler for ${channel}`)
  }
  return handler({}, raw)
}

beforeEach(() => {
  calls.list = []
  noteCloudPairingBindings({ sbx_paired: { environmentId: 'env-paired' } })
  registerOrcaCloudAgentsHandlers('/u')
  registerCloudSecretsHandlers('/u')
})

describe('a paired workspace resolves in every environment-keyed lookup', () => {
  it('the D13 workspace Sources read reaches its sandbox', async () => {
    await call('orcaCloudAgents:workspaceSources', { runtimeEnvironmentId: 'env-paired' })
    expect(calls.list).toEqual(['sources:sbx_paired'])
  })

  it('setting a workspace source reaches its sandbox', async () => {
    await call('orcaCloudAgents:setWorkspaceSource', {
      agent: 'claude',
      source: 'sign-in',
      runtimeEnvironmentId: 'env-paired'
    })
    expect(calls.list).toEqual(['setSource:sbx_paired'])
  })

  it('cloud secrets reach its sandbox', async () => {
    await call('cloudSecrets:workspaceSharing', { runtimeEnvironmentId: 'env-paired' })
    await call('cloudSecrets:refreshEnv', { runtimeEnvironmentId: 'env-paired' })
    expect(calls.list).toEqual(['sharing:sbx_paired', 'refresh:sbx_paired'])
  })

  it('an environment with no pairing and no runtime still answers not_found', async () => {
    expect(
      await call('orcaCloudAgents:workspaceSources', { runtimeEnvironmentId: 'env-other' })
    ).toEqual({ ok: false, error: 'not_found' })
    expect(calls.list).toEqual([])
  })
})
