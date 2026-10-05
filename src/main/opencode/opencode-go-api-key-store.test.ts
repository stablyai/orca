import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeFs from 'node:fs'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'

const home = vi.hoisted(() => {
  const state: { directory: string; readError: Error | null } = { directory: '', readError: null }
  return state
})
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: () => home.directory
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (home.readError) {
        throw home.readError
      }
      return actual.readFileSync(...args)
    }
  }
})
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (key: string) => Buffer.from(`encrypted:${key}`),
    decryptString: (bytes: Buffer) => bytes.toString().slice('encrypted:'.length)
  }
}))

beforeEach(() => {
  home.readError = null
  home.directory = mkdtempSync(join(tmpdir(), 'orca-go-key-store-'))
  vi.resetModules()
})
afterEach(() => rmSync(home.directory, { recursive: true, force: true }))

describe('OpenCode Go main-owned API key file', () => {
  it('persists a versioned encrypted envelope, reads it after restart, and clears it', async () => {
    const store = await import('./opencode-go-api-key-store')
    expect(store.hasOpenCodeGoApiKey()).toBe(false)
    store.saveOpenCodeGoApiKey(' fake-key ')
    expect(store.hasOpenCodeGoApiKey()).toBe(true)
    const path = join(home.directory, '.orca', 'opencode-go-api-key.enc')
    expect(readFileSync(path, 'utf8')).toBe(
      `orca-opencode-go-api-key:v1:encrypted:${Buffer.from('encrypted:fake-key').toString('base64')}`
    )
    vi.resetModules()
    const restarted = await import('./opencode-go-api-key-store')
    expect(restarted.readOpenCodeGoApiKey()).toBe('fake-key')
    restarted.clearOpenCodeGoApiKey()
    expect(restarted.hasOpenCodeGoApiKey()).toBe(false)
    expect(restarted.readOpenCodeGoApiKey()).toBeNull()
  })

  it('keeps the MiniMax cache and file independent', async () => {
    const go = await import('./opencode-go-api-key-store')
    const miniMax = await import('../minimax/minimax-api-key-store')
    go.saveOpenCodeGoApiKey('fake-go')
    miniMax.saveMiniMaxApiKey('fake-minimax')
    expect(go.readOpenCodeGoApiKey()).toBe('fake-go')
    expect(miniMax.readMiniMaxApiKey()).toBe('fake-minimax')
    go.clearOpenCodeGoApiKey()
    expect(miniMax.hasMiniMaxApiKey()).toBe(true)
    expect(miniMax.readMiniMaxApiKey()).toBe('fake-minimax')
  })

  it('rejects empty keys and malformed envelopes without returning the key', async () => {
    const store = await import('./opencode-go-api-key-store')
    expect(() => store.saveOpenCodeGoApiKey(' ')).toThrow('required')
    store.saveOpenCodeGoApiKey('fake-key')
    writeFileSync(join(home.directory, '.orca', 'opencode-go-api-key.enc'), 'fake-invalid-envelope')
    vi.resetModules()
    const restarted = await import('./opencode-go-api-key-store')
    expect(() => restarted.readOpenCodeGoApiKey()).toThrow(
      'OpenCode Go API key could not be decrypted'
    )
  })

  it('throws a distinct unreadable error for a transient read failure', async () => {
    const store = await import('./opencode-go-api-key-store')
    store.saveOpenCodeGoApiKey('fake-key')
    vi.resetModules()
    const restarted = await import('./opencode-go-api-key-store')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    home.readError = Object.assign(new Error('resource busy'), { code: 'EBUSY' })

    expect(() => restarted.readOpenCodeGoApiKey()).toThrow(
      'OpenCode Go API key file could not be read'
    )
    home.readError = null
    expect(restarted.readOpenCodeGoApiKey()).toBe('fake-key')
  })
})
