import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ run: vi.fn() }))
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
it.each([
  { state: 'missing', initial: null },
  { state: 'signed in', initial: credential('a') },
  { state: 'refreshed', initial: credential('a', 2) }
])(
  'refuses creation and replacement without launching WSL or sending credential stdin ($state)',
  async ({ initial }) => {
    let native = initial
    const inputs: unknown[] = []
    mocks.run.mockImplementation(async (spec: { args: string[]; input?: string }) => {
      inputs.push(spec.input)
      if (spec.input) {
        native = Buffer.from(spec.input.split('\n')[2], 'base64').toString('utf8')
      }
      return {
        code: 0,
        stdout: `ORCA_AGY_WSL_REPLY_V1 ${spec.args[4]}\nwritten\n${Buffer.from(native ?? '').toString('base64')}\n`,
        timedOut: false,
        outputTruncated: false
      }
    })
    await expect(
      createAntigravityWslCredentialBackend(authority).write(credential('b'), initial)
    ).rejects.toThrow('Sign in with agy on "Ubuntu", then refresh Accounts and save')
    expect(native).toBe(initial)
    expect(inputs).toEqual([])
  }
)
it('reads exact native bytes with nonce verification and no credential stdin', async () => {
  mocks.run.mockImplementation(async (spec: { args: string[] }) => ({
    code: 0,
    stdout: `ORCA_AGY_WSL_REPLY_V1 ${spec.args[4]}\npresent\n${Buffer.from(credential('a')).toString('base64')}\n`,
    timedOut: false,
    outputTruncated: false
  }))
  expect((await createAntigravityWslCredentialBackend(authority).read())?.contents).toBe(
    credential('a')
  )
  const spec = mocks.run.mock.calls[0]?.[0]
  expect(spec.input).toBeUndefined()
  expect(spec.args[0]).toBe('read')
  expect(spec.distro).toBe('Ubuntu')
  expect(spec.maxOutputBytes).toBe(192 * 1024)
  expect(spec.killOnOutputLimit).toBe(true)
})
it('fails closed on system errors and hides captured credential stderr', async () => {
  mocks.run.mockResolvedValue({ code: 1, stderr: 'private-token', stdout: 'private-token' })
  await expect(createAntigravityWslCredentialBackend(authority).read()).rejects.toThrow(
    'could not be verified'
  )
})
it('rejects a guest identity verification failure', async () => {
  mocks.run.mockResolvedValue({ code: 74, stdout: '', stderr: '', timedOut: false })
  await expect(createAntigravityWslCredentialBackend(authority).read()).rejects.toThrow(
    'could not be verified'
  )
})
it('reports a read conflict without implying an account selection', async () => {
  mocks.run.mockResolvedValue({
    code: 73,
    stdout: '',
    stderr: '',
    timedOut: false,
    outputTruncated: false
  })
  await expect(createAntigravityWslCredentialBackend(authority).read()).rejects.toThrow(
    'The native Antigravity credential changed while it was read; refresh before retrying.'
  )
})
it('refuses writing even with an explicit operation and invalid credentials', async () => {
  const operation = { deadline: Date.now() + 1000, signal: new AbortController().signal }
  await expect(
    createAntigravityWslCredentialBackend(authority).write('invalid', null, operation)
  ).rejects.toThrow('cannot safely switch')
  expect(mocks.run).not.toHaveBeenCalled()
})
