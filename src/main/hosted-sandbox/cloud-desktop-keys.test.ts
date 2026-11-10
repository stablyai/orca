import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtimes: { runtimeEnvironmentId: string; recipe?: { provider?: string } }[] = []
const environments = new Map<string, { source?: string; endpoints: { endpoint: string }[] }>()
let launchEnv: Record<string, string> = {}
const launchCalls: unknown[][] = []

vi.mock('../../shared/ephemeral-vm-runtime-store', () => ({
  listEphemeralVmRuntimes: () => runtimes
}))
vi.mock('../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  resolveEnvironment: (_userData: string, id: string) => {
    const environment = environments.get(id)
    if (!environment) {
      throw new Error('unknown environment')
    }
    return environment
  }
}))
vi.mock('../agent-api-keys/agent-api-key-launch-env', () => ({
  resolveAgentApiKeyLaunchEnv: async (...args: unknown[]) => {
    launchCalls.push(args)
    return launchEnv
  }
}))

const { desktopKeyValueForCloud, isOrcaCloudRuntimeEnvironment } =
  await import('./cloud-desktop-keys')

beforeEach(() => {
  runtimes.length = 0
  environments.clear()
  launchEnv = {}
  launchCalls.length = 0
})

describe('isOrcaCloudRuntimeEnvironment', () => {
  it('is true for an Orca Cloud runtime and false for another VM recipe or a paired machine', () => {
    runtimes.push({ runtimeEnvironmentId: 'env-cloud', recipe: { provider: 'orca-cloud' } })
    runtimes.push({ runtimeEnvironmentId: 'env-own-vm', recipe: { provider: 'my-recipes' } })
    environments.set('env-mac', {
      source: 'manual',
      endpoints: [{ endpoint: 'wss://192.168.1.4:6768' }]
    })
    expect(isOrcaCloudRuntimeEnvironment('/u', 'env-cloud')).toBe(true)
    expect(isOrcaCloudRuntimeEnvironment('/u', 'env-own-vm')).toBe(false)
    expect(isOrcaCloudRuntimeEnvironment('/u', 'env-mac')).toBe(false)
  })

  it('fails closed: a VM with no provider record, or a host on a Vercel Sandbox route, counts as Orca Cloud', () => {
    runtimes.push({ runtimeEnvironmentId: 'env-unknown-recipe' })
    environments.set('env-vm', { source: 'ephemeral-vm', endpoints: [{ endpoint: 'wss://x' }] })
    environments.set('env-paired-cloud', {
      source: 'manual',
      endpoints: [{ endpoint: 'wss://sb-abc123.vercel.run' }]
    })
    expect(isOrcaCloudRuntimeEnvironment('/u', 'env-unknown-recipe')).toBe(true)
    expect(isOrcaCloudRuntimeEnvironment('/u', 'env-vm')).toBe(true)
    expect(isOrcaCloudRuntimeEnvironment('/u', 'env-paired-cloud')).toBe(true)
    expect(isOrcaCloudRuntimeEnvironment('/u', 'env-missing')).toBe(false)
  })
})

describe('desktopKeyValueForCloud', () => {
  it('reads only keys set for every host, for one agent and one variable', async () => {
    launchEnv = { GEMINI_API_KEY: 'AIzaSy-real', OTHER: 'x' }
    expect(await desktopKeyValueForCloud('gemini', 'GEMINI_API_KEY')).toBe('AIzaSy-real')
    expect(await desktopKeyValueForCloud('gemini', 'CURSOR_API_KEY')).toBeNull()
    expect(launchCalls[0]).toEqual(['gemini', 'runtime:orca-cloud'])
  })
})

describe('withHostAgentApiKeyEnv', () => {
  it('adds no desktop keys to a launch on an Orca Cloud VM', async () => {
    runtimes.push({ runtimeEnvironmentId: 'env-cloud', recipe: { provider: 'orca-cloud' } })
    launchEnv = { GEMINI_API_KEY: 'AIzaSy-real' }
    const params = { agent: 'gemini', kind: 'explicit' }
    const { withHostAgentApiKeyEnv } = await import('./cloud-desktop-keys')
    const readStatus = vi.fn()
    expect(
      await withHostAgentApiKeyEnv(
        '/u',
        'env-cloud',
        'terminal.createAgentSession',
        params,
        readStatus
      )
    ).toBe(params)
    expect(launchCalls).toEqual([])
    expect(readStatus).not.toHaveBeenCalled()
  })
})
