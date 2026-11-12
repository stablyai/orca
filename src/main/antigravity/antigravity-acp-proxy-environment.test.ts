import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import type * as ProcessHost from '@orca/process-host'
import { resolveAcpLaunchInvocation } from '../acp/launch/acp-structured-launch-resolution'
import { ANTIGRAVITY_LAUNCH_SPEC } from './antigravity-acp-launch-spec'
import { prepareAntigravityAcpProxyEnvironment } from './antigravity-acp-proxy-environment'

vi.mock('@orca/process-host', async (original) => ({
  ...(await original<typeof ProcessHost>()),
  runProcess: vi.fn()
}))

const DEFAULT_SYSTEM_PROXY = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  ExcludeSimpleHostnames : 1
  HTTPEnable : 1
  HTTPProxy : proxy.example
  HTTPPort : 8080
  HTTPSEnable : 1
  HTTPSProxy : secure.example
  HTTPSPort : 8443
  SOCKSEnable : 1
  SOCKSProxy : 127.0.0.1
  SOCKSPort : 9090
}`

function result(stdout = DEFAULT_SYSTEM_PROXY) {
  return { code: 0, signal: null, stdout, stderr: '', timedOut: false }
}

function invocation(env: Record<string, string>, current = () => true, host = false) {
  return resolveAcpLaunchInvocation(
    ANTIGRAVITY_LAUNCH_SPEC,
    { variable: 'GEMINI_HOME', path: host ? '/fixture/.gemini' : '/fixture/antigravity-chat' },
    {
      operation: { current },
      resolveEnvironment: async () => ({ ...env }),
      inheritedEnv: {},
      resolveCommand: (command) => command,
      dataDirectory: '/fixture/missing-runtime'
    }
  )
}

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  vi.mocked(runProcess).mockReset().mockResolvedValue(result())
})
afterEach(() => vi.restoreAllMocks())

it('launches managed Antigravity with system routes and loopback bypass under the default macOS exceptions', async () => {
  const { env } = await invocation({ KEEP: 'user-value' })
  expect(env).toMatchObject({
    KEEP: 'user-value',
    HTTP_PROXY: 'http://proxy.example:8080',
    http_proxy: 'http://proxy.example:8080',
    HTTPS_PROXY: 'http://secure.example:8443',
    https_proxy: 'http://secure.example:8443',
    SOCKS_PROXY: 'http://127.0.0.1:9090',
    socks_proxy: 'http://127.0.0.1:9090',
    NO_PROXY: '.local,localhost,127.0.0.1,::1,[::1]',
    no_proxy: '.local,localhost,127.0.0.1,::1,[::1]'
  })
  expect((await invocation({}, () => true, true)).env).not.toHaveProperty('NO_PROXY')
})

it.each([
  [
    { NO_PROXY: 'corp.example', no_proxy: 'corp.example' },
    {
      NO_PROXY: 'corp.example,localhost,127.0.0.1,::1,[::1]',
      no_proxy: 'corp.example,localhost,127.0.0.1,::1,[::1]'
    }
  ],
  [
    { NO_PROXY: 'corp.example' },
    {
      NO_PROXY: 'corp.example,localhost,127.0.0.1,::1,[::1]',
      no_proxy: 'corp.example,localhost,127.0.0.1,::1,[::1]'
    }
  ],
  [
    { no_proxy: 'corp.example', No_proxy: 'corp.example' },
    {
      NO_PROXY: 'corp.example,localhost,127.0.0.1,::1,[::1]',
      no_proxy: 'corp.example,localhost,127.0.0.1,::1,[::1]',
      No_proxy: 'corp.example,localhost,127.0.0.1,::1,[::1]'
    }
  ],
  [{ no_proxy: '*' }, { NO_PROXY: '*', no_proxy: '*' }]
])(
  'preserves compatible external exclusions and bypasses loopback: %j',
  async (bypass, expected) => {
    const env: Record<string, string> = { socks_proxy: 'socks5h://127.0.0.1:9090' }
    await prepareAntigravityAcpProxyEnvironment(env, bypass)
    expect(env).toEqual({ socks_proxy: 'socks5h://127.0.0.1:9090', ...expected })
  }
)

const incompatibleBypasses: Record<string, string>[] = [
  { No_Proxy: 'corp.example' },
  { NO_PROXY: 'upper.example', No_proxy: 'corp.example' },
  { NO_PROXY: 'upper.example', no_proxy: 'lower.example' },
  { NO_PROXY: 'corp.example', no_proxy: '' },
  { NO_PROXY: '', no_proxy: 'corp.example' },
  { no_proxy: 'lower.example', No_proxy: 'corp.example' }
]
it.each(incompatibleBypasses)(
  'leaves incompatible external proxy selections unchanged: %j',
  async (bypass) => {
    const env: Record<string, string> = { socks_proxy: 'socks5h://127.0.0.1:9090', ...bypass }
    await prepareAntigravityAcpProxyEnvironment(env, {})
    expect(env).toEqual({ socks_proxy: 'socks5h://127.0.0.1:9090', ...bypass })
  }
)

it.each([
  DEFAULT_SYSTEM_PROXY.replace('    1 : 169.254/16', '    1 : 169.254/16\n    2 : *.corp.example'),
  DEFAULT_SYSTEM_PROXY.replace('*.local', 'googleapis.com'),
  DEFAULT_SYSTEM_PROXY.replace('*.local', '*google*'),
  DEFAULT_SYSTEM_PROXY.replace('169.254/16', '142.250/15'),
  DEFAULT_SYSTEM_PROXY.replace('  HTTPEnable : 1', '  ProxyAutoConfigEnable : 1\n  HTTPEnable : 1'),
  '<dictionary> {\n  HTTPEnable : 1',
  '<dictionary> {\n}'
])('retains the original environment when system policy cannot be mirrored: %s', async (stdout) => {
  vi.mocked(runProcess).mockResolvedValue(result(stdout))
  const env = { KEEP: 'user-value' }
  await prepareAntigravityAcpProxyEnvironment(env, {})
  expect(env).toEqual({ KEEP: 'user-value' })
})

it.each(['linux', 'win32'] as const)('keeps a proxy-free %s launch unchanged', async (platform) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  const env = { KEEP: 'user-value' }
  await prepareAntigravityAcpProxyEnvironment(env, {})
  expect(env).toEqual({ KEEP: 'user-value' })
})

it('does not resolve a canceled launch after awaiting host proxy discovery', async () => {
  let current = true
  vi.mocked(runProcess).mockImplementation(async () => {
    current = false
    return result()
  })
  await expect(invocation({}, () => current)).rejects.toThrow('Agent resolution operation ended')
})

it.each([10, 100])(
  'shares one host snapshot for a burst of %i launches and rereads after settlement',
  async (count) => {
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof runProcess>>>()
    vi.mocked(runProcess).mockReturnValueOnce(pending.promise)
    const envs: Record<string, string>[] = Array.from({ length: count }, () => ({}))
    const burst = Promise.all(envs.map((env) => prepareAntigravityAcpProxyEnvironment(env, {})))
    // One host-wide snapshot supplies the entire concurrent burst, independent of its caller count.
    expect(runProcess).toHaveBeenCalledTimes(1)
    pending.resolve(result())
    await burst
    vi.mocked(runProcess).mockResolvedValue(result('<dictionary> {\n}'))
    const later = {}
    await prepareAntigravityAcpProxyEnvironment(later, {})
    expect(later).toEqual({})
    expect(envs.at(-1)?.socks_proxy).toBe('http://127.0.0.1:9090')
  }
)
