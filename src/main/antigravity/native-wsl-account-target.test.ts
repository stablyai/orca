import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ run: vi.fn(), environment: vi.fn() }))
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: mocks.run }))
vi.mock('../wsl/wsl-guest-environment', () => ({ getWslGuestEnvironment: mocks.environment }))
import { resolveAntigravityWslTarget } from './native-wsl-account-target'
const operation = () => ({ deadline: Date.now() + 15_000, signal: new AbortController().signal })
function identity(distro = 'Ubuntu', uid = '1000', home = '/home/user', canonical = home): void {
  mocks.environment.mockResolvedValue({ path: '/usr/bin:/bin', home, envBinary: '/usr/bin/env' })
  mocks.run.mockImplementation(async (spec: { script: string }) => {
    const begin = /__ORCA_WSL_CAPTURE_BEGIN_[a-z0-9]+__/.exec(spec.script)?.[0]
    const end = /__ORCA_WSL_CAPTURE_END_[a-z0-9]+__/.exec(spec.script)?.[0]
    return {
      code: 0,
      stdout: `banner\n${begin}${[distro, uid, home, canonical].join('\0')}${end}`,
      stderr: '',
      timedOut: false,
      outputTruncated: false
    }
  })
}
beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  identity()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})
it('resolves the actual default distro and requests a fresh login HOME', async () => {
  const result = await resolveAntigravityWslTarget({ runtime: 'wsl', wslDistro: null }, operation())
  expect(result.distro).toBe('Ubuntu')
  expect(result.credentialPath).toBe('/home/user/.gemini/antigravity-cli/antigravity-oauth-token')
  expect(result.authorityId).toMatch(/^[a-f0-9]{64}$/)
  expect(mocks.environment.mock.calls[0]?.[2]).toMatchObject({ fresh: true })
})
it('normalizes distro aliases but separates changed user and HOME', async () => {
  const resolve = () =>
    resolveAntigravityWslTarget({ runtime: 'wsl', wslDistro: 'ubuntu' }, operation())
  const first = await resolve()
  identity('ubuntu')
  expect((await resolve()).authorityId).toBe(first.authorityId)
  identity('Ubuntu', '1001')
  expect((await resolve()).authorityId).not.toBe(first.authorityId)
  identity('Ubuntu', '1000', '/home/other')
  expect((await resolve()).authorityId).not.toBe(first.authorityId)
})
it.each([
  ['Ubuntu', 'invalid', '/home/user', '/home/user'],
  ['Ubuntu', '1000', '/home/link', '/home/user'],
  ['Debian', '1000', '/home/user', '/home/user']
])('rejects invalid or inconsistent identity %j', async (...values) => {
  identity(...values)
  await expect(
    resolveAntigravityWslTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' }, operation())
  ).rejects.toThrow('WSL account target')
})
it('refuses non-Windows hosts before probing', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  await expect(resolveAntigravityWslTarget({ runtime: 'wsl' }, operation())).rejects.toThrow(
    'Windows'
  )
  expect(mocks.run).not.toHaveBeenCalled()
})
it('rejects timeout and clipped identity responses', async () => {
  mocks.run.mockResolvedValue({ code: 0, stdout: '', timedOut: false, outputTruncated: true })
  await expect(resolveAntigravityWslTarget({ runtime: 'wsl' }, operation())).rejects.toThrow(
    'WSL account target'
  )
})
