import { expect, it, vi } from 'vitest'
import { AntigravityLaunchRestoreError } from './native-account-login-view'
import { credential, harness, refreshedWithoutIdToken } from './native-account-test-fixtures'
import { agyLoginHolderAfter, agyPreparedLogin } from './native-account-launch'

// Two saved accounts, `a` selected, and an agy still running on `b` wrote b's login back. agy's
// login reads here without a dialog only through `read` (Linux keyring, Windows).
async function driftedToB() {
  const h = harness()
  const a = (await h.service.addCurrentAccount()).activeAccountId!
  h.setNative(credential('b', 2))
  const b = (await h.service.addCurrentAccount()).activeAccountId!
  await h.service.selectAccount(a)
  h.setNative(refreshedWithoutIdToken(3, 'refresh-2'))
  return { h, a, b }
}

async function restoreFailure(prepare: Promise<unknown>): Promise<AntigravityLaunchRestoreError> {
  const error = await prepare.then(
    () => null,
    (failure: unknown) => failure
  )
  if (!(error instanceof AntigravityLaunchRestoreError)) {
    throw new Error(`expected a failed restore, got ${String(error)}`)
  }
  return error
}

it('names the account a failed restore found holding the login, before it wrote anything', async () => {
  const { h, b } = await driftedToB()
  h.setSignInHeld(true)
  const error = await restoreFailure(h.service.prepareForLaunch({ mayPrompt: false }))
  expect(error.message).toContain('sign-in is in progress')
  expect(error.holder).toBe(b)
})

it('names nobody once a restore wrote the login and could not read it back', async () => {
  const { h, a, b } = await driftedToB()
  // The write of `a` lands; the readback that would confirm it fails.
  const write = h.backend.write
  vi.mocked(h.backend.write).mockImplementationOnce(async (contents, expected) => {
    await write(contents, expected)
    vi.mocked(h.backend.read).mockRejectedValue(new Error('keyring went away'))
  })
  const error = await restoreFailure(h.service.prepareForLaunch({ mayPrompt: false }))
  expect(error.holder).not.toBe(a)
  expect(error.holder).not.toBe(b)
  expect(error.holder).toBeNull()
})

it('reads who holds the login where that read raises no dialog', async () => {
  const { h, b } = await driftedToB()
  expect(await h.service.readLoginHolder()).toBe(b)
})

it('records a launch on another home or credential store as on an unknown login, never the host default', () => {
  const mismatch = new Error(
    'This agy launch uses a different credential authority from the selected Antigravity account.'
  )
  expect(agyLoginHolderAfter(mismatch)).toBeNull()
  expect(agyPreparedLogin('a', agyLoginHolderAfter(mismatch), mismatch.message)).toEqual({
    key: '?',
    target: 'a',
    failure: mismatch.message
  })
  expect(agyPreparedLogin('a', 'a', 'unused')).toEqual({ key: 'a', target: 'a' })
  expect(agyPreparedLogin('a', 'b', 'signed in elsewhere')).toMatchObject({ key: 'b', target: 'a' })
})
