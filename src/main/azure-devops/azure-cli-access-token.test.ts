import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { resolveCommandOnLocalPath } from '../ipc/command-path/command-path-resolver'
import {
  hydrateShellPath,
  mergePathSegments
} from '../startup/shell-environment/hydrate-shell-path'
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
const windowsCliPath = 'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin'
const shellCliPath = '/usr/local/bin'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1767225600000)
  vi.mocked(hydrateShellPath).mockResolvedValue({ ok: true, segments: [], failureReason: 'none' })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: nativePlatform })
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

it.each([
  ['win32', windowsCliPath, `${windowsCliPath}\\az.cmd`],
  ['linux', shellCliPath, `${shellCliPath}/az`]
] as const)('acquires the token using the host PATH on %s', async (platform, path, program) => {
  Object.defineProperty(process, 'platform', { value: platform })
  vi.stubEnv('PATH', '')
  vi.mocked(hydrateShellPath).mockResolvedValue({
    ok: true,
    segments: [shellCliPath],
    failureReason: 'none'
  })
  vi.mocked(mergePathSegments).mockImplementation((segments) => {
    process.env.PATH = segments[0]
    return segments
  })
  vi.mocked(mergePersistedWindowsPathAsync).mockImplementation(async (env) => {
    env.PATH = windowsCliPath
  })
  vi.mocked(resolveCommandOnLocalPath).mockImplementation(async (command, options) =>
    command === 'az' && options?.env?.PATH === path ? program : null
  )
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
  [{ stdout: '{"accessToken":"cli-token","expires_on":1767225600}' }, 'invalid-token-response'],
  [{ stdout: '{"accessToken":"cli-token","expiresOn":"2029-01-01"}' }, 'invalid-token-response']
] as const)('sanitizes invalid token command results (%#)', async (override, code) => {
  vi.mocked(resolveCommandOnLocalPath).mockResolvedValue('/usr/bin/az')
  vi.mocked(runProcess).mockResolvedValue({ ...result, ...override })
  await expect(acquireAzureCliAccessToken()).rejects.toMatchObject({ code, message: code })
})

it('distinguishes a missing executable from a failed login', async () => {
  vi.mocked(resolveCommandOnLocalPath).mockResolvedValue(null)
  await expect(acquireAzureCliAccessToken()).rejects.toMatchObject({ code: 'cli-not-installed' })
})
