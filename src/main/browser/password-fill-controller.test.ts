import { describe, expect, it, vi } from 'vitest'
import { PasswordFillController } from './password-fill-controller'
import { BROWSER_PASSWORD_BRIDGE_WORLD_ID } from '../../shared/browser-credential-types'

function fakeGuest() {
  return {
    isDestroyed: () => false,
    executeJavaScriptInIsolatedWorld: vi.fn().mockResolvedValue(true)
  }
}

describe('PasswordFillController', () => {
  it('injects the bridge into the password isolated world', async () => {
    const guest = fakeGuest()
    const ctrl = new PasswordFillController(() => guest as never)
    await ctrl.injectBridge('tab-1', 'tok_aaaaaaaaaaaaaaaa', true)
    expect(guest.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(
      BROWSER_PASSWORD_BRIDGE_WORLD_ID,
      expect.arrayContaining([
        expect.objectContaining({ code: expect.stringContaining('__orcaPasswordBridge') })
      ]),
      false
    )
  })

  it('returns false when the guest is missing', async () => {
    const ctrl = new PasswordFillController(() => null)
    expect(await ctrl.fill('tab-x', 'pf-1', 'me', 'pw')).toBe(false)
  })

  it('injects a fill call carrying the credentials', async () => {
    const guest = fakeGuest()
    const ctrl = new PasswordFillController(() => guest as never)
    await ctrl.fill('tab-1', 'pf-1', 'me', 'pw')
    const [, codeArg] = guest.executeJavaScriptInIsolatedWorld.mock.calls[0]
    expect(codeArg[0].code).toContain('pf-1')
    expect(codeArg[0].code).toContain('"pw"')
  })
})
