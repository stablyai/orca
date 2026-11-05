import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secret-store'
import type { BrowserPasswordGuestCapture } from '../../shared/browser-passwords-types'
import { BrowserPasswordStore } from './browser-password-store'

const send = vi.fn()
vi.mock('../browser/browser-manager', () => ({
  browserManager: {
    getRendererContextForGuest: () => ({
      browserPageId: 'page-1',
      renderer: { send, isDestroyed: () => false }
    })
  }
}))
vi.mock('./browser-password-vault-access', () => ({
  browserPasswordVaultFor: () => store
}))

const { offerBrowserPasswordSave, respondToBrowserPasswordSavePrompt } =
  await import('./browser-password-save-prompts')

let dir: string
let store: BrowserPasswordStore
const ORIGIN = 'https://example.com'

function login(password: string): Parameters<typeof offerBrowserPasswordSave>[0]['login'] {
  const capture: BrowserPasswordGuestCapture = {
    formSignature: 'form-1',
    kind: 'login',
    usernameFieldName: 'email',
    passwordFieldName: 'password',
    action: null,
    username: 'ada',
    password,
    newPassword: null
  }
  return { origin: ORIGIN, capture, username: 'ada' }
}

function offer(password: string): void {
  offerBrowserPasswordSave({
    guestId: 1,
    browserProfileId: 'default',
    vault: store,
    login: login(password)
  })
}

function lastPrompt(): { promptId: string; mode: string } {
  return send.mock.calls.findLast(([channel]) => channel === 'browserPasswords:savePrompt')?.[1]
}

beforeEach(() => {
  send.mockReset()
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`sealed:${text}`),
    decryptString: (cipher) => cipher.toString().replace(/^sealed:/, ''),
    describeProtectionGap: () => null
  })
  dir = mkdtempSync(join(tmpdir(), 'browser-password-prompts-'))
  store = new BrowserPasswordStore(join(dir, 'vault.json'))
})

afterEach(() => {
  _resetSecretStoreForTests()
  rmSync(dir, { recursive: true, force: true })
})

describe('offerBrowserPasswordSave', () => {
  it('does not let a pending offer recreate a deleted vault', () => {
    offer('pw-1')
    const promptId = lastPrompt().promptId
    expect(store.deleteFile().ok).toBe(true)
    store = new BrowserPasswordStore(join(dir, 'vault.json'))
    expect(respondToBrowserPasswordSavePrompt({ promptId, action: 'save' })).toBe(false)
    expect(store.list()).toEqual({ ok: true, value: [] })
  })
})
