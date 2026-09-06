import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  disconnectKaneo,
  getKaneoStatus,
  readKaneoCredential,
  saveKaneoCredential
} from './credential-store'
import { readStoredCredentialToken } from '../integration-credential-file'

const home = vi.hoisted(() => ({ path: '' }))
vi.mock('node:os', async (original) => ({
  ...(await original<object>()),
  homedir: () => home.path
}))
vi.mock('../integration-credential-file', async (original) => {
  const actual = await original<object>()
  return {
    ...actual,
    writeEncryptedCredential: (_service: string, path: string, value: string) =>
      writeFileSync(path, value, { mode: 0o600 }),
    readStoredCredentialToken: vi.fn((_service: string, raw: Buffer) => raw.toString('utf8'))
  }
})
beforeEach(() => {
  home.path = mkdtempSync(join(tmpdir(), 'orca-kaneo-'))
  vi.clearAllMocks()
})
afterEach(() => rmSync(home.path, { recursive: true, force: true }))
const credential = { siteUrl: 'https://tasks.example.com', apiKey: 'test-secret-key' }

describe('Kaneo credential storage', () => {
  it('keeps credentials out of status and metadata and binds the origin inside the secret', () => {
    saveKaneoCredential(credential)
    expect(getKaneoStatus()).toEqual({ connected: true, siteUrl: credential.siteUrl })
    expect(readStoredCredentialToken).not.toHaveBeenCalled()
    expect(readFileSync(join(home.path, '.orca', 'kaneo.json'), 'utf8')).not.toContain(
      credential.apiKey
    )
    expect(readKaneoCredential()).toEqual(credential)
    if (process.platform !== 'win32') {
      expect(statSync(join(home.path, '.orca', 'kaneo.enc')).mode & 0o777).toBe(0o600)
    }
    disconnectKaneo()
    expect(getKaneoStatus()).toEqual({ connected: false, siteUrl: null })
    expect(readKaneoCredential()).toBeNull()
  })

  it('does not expose corrupted secret contents in errors', () => {
    saveKaneoCredential(credential)
    writeFileSync(join(home.path, '.orca', 'kaneo.enc'), 'test-secret-key broken JSON')
    expect(() => readKaneoCredential()).toThrow('Saved Kaneo credentials are invalid')
    expect(() => readKaneoCredential()).not.toThrow('test-secret-key')
  })
})
