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
  it('offers to save a new login and stores it only when the user says save', () => {
    offer('pw-1')
    expect(lastPrompt()).toMatchObject({ mode: 'save', origin: ORIGIN, username: 'ada' })
    expect(store.list()).toEqual({ ok: true, value: [] })
    expect(
      respondToBrowserPasswordSavePrompt({ promptId: lastPrompt().promptId, action: 'save' })
    ).toBe(true)
    const entries = store.list()
    expect(entries.ok && entries.value.map((entry) => entry.username)).toEqual(['ada'])
  })

  it('stays quiet on a site the user said never to save for', () => {
    store.addNever(ORIGIN)
    offer('pw-1')
    expect(lastPrompt()).toBeUndefined()
  })

  it('offers an update when a saved username signs in with a new password', () => {
    const added = store.add({ origin: ORIGIN, username: 'ada', password: 'old' })
    const id = added.ok ? added.value.entry.id : ''
    offer('new')
    expect(lastPrompt()).toMatchObject({ mode: 'update' })
    respondToBrowserPasswordSavePrompt({ promptId: lastPrompt().promptId, action: 'save' })
    expect(store.getPassword(id)).toEqual({ ok: true, value: 'new' })
  })

  it('never sends the password to the renderer', () => {
    offer('top-secret')
    expect(JSON.stringify(send.mock.calls)).not.toContain('top-secret')
  })
})
