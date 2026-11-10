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
  },
  withAgentApiKeyLaunchEnv: async (env: Record<string, string> | undefined, ...args: unknown[]) => {
    launchCalls.push(args)
    return { ...env, ...launchEnv }
  }
}))
const sshTargets = new Map<
  string,
  { host: string; label: string; configHost?: string; proxyCommand?: string }
>()
vi.mock('../ssh/targets/ssh-target-registry', () => ({
  getSshTargetRegistryStore: () => ({ getTarget: (id: string) => sshTargets.get(id) })
}))

const { desktopKeyValueForCloud, isOrcaCloudRuntimeEnvironment } =
  await import('./cloud-desktop-keys')

beforeEach(() => {
  runtimes.length = 0
  environments.clear()
  launchEnv = {}
  launchCalls.length = 0
  sshTargets.clear()
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
    const { setCloudDesktopKeysUserDataPath, withHostAgentApiKeyEnv } =
      await import('./cloud-desktop-keys')
    setCloudDesktopKeysUserDataPath('/u')
    const readStatus = vi.fn()
    expect(
      await withHostAgentApiKeyEnv('env-cloud', 'terminal.createAgentSession', params, readStatus)
    ).toBe(params)
    expect(launchCalls).toEqual([])
    expect(readStatus).not.toHaveBeenCalled()
  })
})

describe('withHostAgentApiKeyLaunchEnv (SSH)', () => {
  it('sends no desktop keys over SSH into an Orca Cloud workspace, and does elsewhere', async () => {
    const { withHostAgentApiKeyLaunchEnv } = await import('./cloud-desktop-keys')
    launchEnv = { CURSOR_API_KEY: 'key_real' }
    sshTargets.set('t-cloud', {
      host: 'orca-api-7f3a',
      label: 'orca-api-7f3a',
      configHost: 'orca-api-7f3a'
    })
    sshTargets.set('t-proxy', {
      host: 'box',
      label: 'box',
      proxyCommand: '/Applications/Orca.app/bin/orca ssh-proxy env-1'
    })
    sshTargets.set('t-devbox', { host: 'devbox.lan', label: 'devbox' })
    expect(await withHostAgentApiKeyLaunchEnv({ A: '1' }, 'cursor', 't-cloud')).toEqual({ A: '1' })
    expect(await withHostAgentApiKeyLaunchEnv({ A: '1' }, 'cursor', 't-proxy')).toEqual({ A: '1' })
    expect(launchCalls).toEqual([])
    expect(await withHostAgentApiKeyLaunchEnv({ A: '1' }, 'cursor', 't-devbox')).toEqual({
      A: '1',
      CURSOR_API_KEY: 'key_real'
    })
    expect(await withHostAgentApiKeyLaunchEnv(undefined, 'cursor', null)).toEqual({
      CURSOR_API_KEY: 'key_real'
    })
  })
})

describe('withoutCarriedAgentCredentials (on the VM)', () => {
  it('on an Orca Cloud VM, drops agent credentials a launch tries to set to anything but the session value', async () => {
    const { withoutCarriedAgentCredentials } = await import('./cloud-desktop-keys')
    const host = { ORCA_IS_CLOUD: '1', GEMINI_API_KEY: 'orca-ph-gemini-api-key-sbx1' }
    expect(
      withoutCarriedAgentCredentials(
        {
          GEMINI_API_KEY: 'AIzaSy-from-a-desktop',
          OPENROUTER_API_KEY: 'sk-or-from-a-desktop',
          CURSOR_API_KEY: 'key_from_a_desktop',
          FOO: 'bar'
        },
        host
      )
    ).toEqual({ FOO: 'bar' })
    // The session's own value (the stand-in) may be passed through unchanged.
    expect(
      withoutCarriedAgentCredentials({ GEMINI_API_KEY: 'orca-ph-gemini-api-key-sbx1' }, host)
    ).toEqual({
      GEMINI_API_KEY: 'orca-ph-gemini-api-key-sbx1'
    })
  })

  it('changes nothing on any other host', async () => {
    const { withoutCarriedAgentCredentials } = await import('./cloud-desktop-keys')
    const env = { GEMINI_API_KEY: 'AIzaSy-local' }
    expect(withoutCarriedAgentCredentials(env, {})).toBe(env)
  })
})

describe('withHostAgentApiKeyEnv asks the host', () => {
  it('sends no keys to a host that says it is an Orca Cloud VM, even one paired by hand', async () => {
    const { setCloudDesktopKeysUserDataPath, withHostAgentApiKeyEnv } =
      await import('./cloud-desktop-keys')
    setCloudDesktopKeysUserDataPath('/u')
    environments.set('env-tunnel', {
      source: 'manual',
      endpoints: [{ endpoint: 'wss://127.0.0.1:6768' }]
    })
    launchEnv = { CODEX_API_KEY: 'custom-name-real-key' }
    const params = { launchAgent: 'codex', command: 'codex', env: { A: '1' } }
    const cloudStatus = async () => ({
      ok: true as const,
      id: 's',
      result: { capabilities: ['host.orca-cloud.v1'] },
      _meta: { runtimeId: 'r' }
    })
    expect(await withHostAgentApiKeyEnv('env-tunnel', 'terminal.create', params, cloudStatus)).toBe(
      params
    )
  })

  it('sends keys to a host that says otherwise, and nothing when the host does not answer', async () => {
    const { setCloudDesktopKeysUserDataPath, withHostAgentApiKeyEnv } =
      await import('./cloud-desktop-keys')
    setCloudDesktopKeysUserDataPath('/u')
    environments.set('env-mac', {
      source: 'manual',
      endpoints: [{ endpoint: 'wss://192.168.1.4:6768' }]
    })
    environments.set('env-silent', {
      source: 'manual',
      endpoints: [{ endpoint: 'wss://192.168.1.5:6768' }]
    })
    launchEnv = { CODEX_API_KEY: 'custom-name-real-key' }
    const params = { launchAgent: 'codex', command: 'codex', env: { A: '1' } }
    const plainStatus = async () => ({
      ok: true as const,
      id: 's',
      result: { capabilities: [] },
      _meta: { runtimeId: 'r' }
    })
    expect(await withHostAgentApiKeyEnv('env-mac', 'terminal.create', params, plainStatus)).toEqual(
      {
        ...params,
        env: { CODEX_API_KEY: 'custom-name-real-key', A: '1' }
      }
    )
    const silent = async () => {
      throw new Error('unreachable')
    }
    expect(await withHostAgentApiKeyEnv('env-silent', 'terminal.create', params, silent)).toBe(
      params
    )
  })
})
