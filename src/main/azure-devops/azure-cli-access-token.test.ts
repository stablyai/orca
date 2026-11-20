import { afterEach, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { resolveCommandOnLocalPath } from '../ipc/command-path/command-path-resolver'
import { hydrateShellPath } from '../startup/shell-environment/hydrate-shell-path'
import { mergePersistedWindowsPathAsync } from '../pty/environment/windows-environment-path'
import { acquireAzureCliAccessToken } from './azure-cli-access-token'

vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))
vi.mock('../ipc/command-path/command-path-resolver', () => ({ resolveCommandOnLocalPath: vi.fn() }))
vi.mock('../startup/shell-environment/hydrate-shell-path', () => ({
  hydrateShellPath: vi.fn(),
  mergePathSegments: vi.fn()
}))
vi.mock('../pty/environment/windows-environment-path', () => ({
  mergePersistedWindowsPathAsync: vi.fn()
}))

const result: Awaited<ReturnType<typeof runProcess>> = {
  code: 0,
  signal: null,
  stdout: '{"accessToken":"cli-token","expires_on":"1893456000"}',
  stderr: '',
  timedOut: false
}
const nativePlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: nativePlatform })
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

it.each([
  ['win32', 'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd'],
  ['linux', '/usr/local/bin/az'],
  ['darwin', '/opt/homebrew/bin/az']
] as const)('acquires through the resolved native executable on %s', async (platform, program) => {
  Object.defineProperty(process, 'platform', { value: platform })
  vi.mocked(hydrateShellPath).mockResolvedValue({ ok: true, segments: [], failureReason: 'none' })
  vi.mocked(mergePersistedWindowsPathAsync).mockResolvedValue(undefined)
  vi.mocked(resolveCommandOnLocalPath).mockResolvedValue(program)
  vi.mocked(runProcess).mockImplementation(async (spec) => {
    expect(spec.program).toBe(program)
    expect(spec.args).toEqual([
      'account',
      'get-access-token',
      '--resource',
      '499b84ac-1321-427f-aa17-267ca6975798',
      '--output',
      'json',
      '--only-show-errors'
    ])
    return result
  })
  await expect(acquireAzureCliAccessToken()).resolves.toEqual({
    accessToken: 'cli-token',
    expiresAtMs: 1893456000000
  })
})

it.each([
  [{ code: 1, stderr: "Please run 'az login'" }, 'login-required'],
  [{ code: 1, stderr: 'secret diagnostics' }, 'token-acquisition-failed'],
  [{ timedOut: true }, 'cli-timeout'],
  [{ outputTruncated: true }, 'invalid-token-response'],
  [{ stdout: 'malformed secret output' }, 'invalid-token-response'],
  [{ stdout: '{"accessToken":"cli-token","expires_on":1}' }, 'invalid-token-response'],
  [{ stdout: '{"accessToken":"cli-token","expiresOn":"2029-01-01"}' }, 'invalid-token-response']
] as const)('sanitizes invalid token command results (%#)', async (override, code) => {
  vi.mocked(hydrateShellPath).mockResolvedValue({ ok: true, segments: [], failureReason: 'none' })
  vi.mocked(resolveCommandOnLocalPath).mockResolvedValue('/usr/bin/az')
  vi.mocked(runProcess).mockResolvedValue({ ...result, ...override })
  await expect(acquireAzureCliAccessToken()).rejects.toMatchObject({ code, message: code })
})

it('distinguishes a missing executable from a failed login', async () => {
  vi.mocked(hydrateShellPath).mockResolvedValue({ ok: true, segments: [], failureReason: 'none' })
  vi.mocked(resolveCommandOnLocalPath).mockResolvedValue(null)
  await expect(acquireAzureCliAccessToken()).rejects.toMatchObject({ code: 'cli-not-installed' })
})
