import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), run: vi.fn() }))
vi.mock('./native-wsl-account-target', () => ({ resolveAntigravityWslTarget: mocks.resolve }))
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: mocks.run }))
import { createAntigravityWslCredentialBackend } from './native-wsl-credential-backend'
import { credential } from './native-account-test-fixtures'
const authority = {
  distro: 'Ubuntu',
  uid: 1000,
  home: '/home/u',
  canonicalHome: '/home/u',
  authorityId: 'a'.repeat(64),
  credentialPath: '/home/u/.gemini/antigravity-cli/antigravity-oauth-token'
}
afterEach(() => vi.resetAllMocks())
it('sends credentials only on stdin and verifies the nonce on readback', async () => {
  mocks.resolve.mockResolvedValue(authority)
  mocks.run.mockImplementation(async (spec: { args: string[] }) => ({
    code: 0,
    stdout: `ORCA_AGY_WSL_REPLY_V1 ${spec.args[4]}\nwritten\n${Buffer.from(credential('b')).toString('base64')}\n`,
    timedOut: false,
    outputTruncated: false
  }))
  await createAntigravityWslCredentialBackend(authority).write(credential('b'), credential('a'))
  const spec = mocks.run.mock.calls[0]?.[0]
  expect(spec.input).toContain(Buffer.from(credential('b')).toString('base64'))
  expect(JSON.stringify({ args: spec.args, env: spec.env, script: spec.script })).not.toContain(
    'synthetic'
  )
  expect(spec.distro).toBe('Ubuntu')
})
it('fails closed on system errors and hides captured credential stderr', async () => {
  mocks.resolve.mockResolvedValue(authority)
  mocks.run.mockResolvedValue({ code: 1, stderr: 'private-token', stdout: 'private-token' })
  await expect(createAntigravityWslCredentialBackend(authority).read()).rejects.toThrow(
    'could not be verified'
  )
})
it('rejects a changed guest user before accessing credentials', async () => {
  mocks.resolve.mockResolvedValue({ ...authority, authorityId: 'b'.repeat(64) })
  await expect(createAntigravityWslCredentialBackend(authority).read()).rejects.toThrow(
    'authority changed'
  )
  expect(mocks.run).not.toHaveBeenCalled()
})
