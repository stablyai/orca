import type * as Fs from 'node:fs'
import type * as CredentialFile from '../integration-credential-file'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  disconnectKaneo,
  getKaneoStatus,
  readKaneoCredential,
  saveKaneoCredential
} from './credential-store'
import {
  readStoredCredentialToken,
  writeCredentialFileAtomic
} from '../integration-credential-file'

const home = vi.hoisted(() => ({ path: '' }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof Fs>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})
vi.mock('node:os', async (original) => ({
  ...(await original<object>()),
  homedir: () => home.path
}))
vi.mock('../integration-credential-file', async (original) => {
  const actual = await original<typeof CredentialFile>()
  return {
    ...actual,
    writeCredentialFileAtomic: vi.fn(actual.writeCredentialFileAtomic),
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
  it('keeps the previous connection when staging metadata fails', () => {
    saveKaneoCredential(credential)
    vi.mocked(writeCredentialFileAtomic).mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    expect(() =>
      saveKaneoCredential({ siteUrl: 'https://other.example', apiKey: 'new-key' })
    ).toThrow('disk full')
    expect(getKaneoStatus()).toEqual({ connected: true, siteUrl: credential.siteUrl })
    expect(readKaneoCredential()).toEqual(credential)
    expect(readdirSync(join(home.path, '.orca')).sort()).toEqual(['kaneo.enc', 'kaneo.json'])
  })

  it.each([false, true])(
    'rolls back a failed metadata replacement (existing=%s)',
    async (existing) => {
      if (existing) {
        saveKaneoCredential(credential)
      }
      const fs = await vi.importActual<typeof Fs>('node:fs')
      vi.mocked(renameSync)
        .mockImplementationOnce(fs.renameSync)
        .mockImplementationOnce(() => {
          throw new Error('rename denied')
        })
      expect(() =>
        saveKaneoCredential({ siteUrl: 'https://other.example', apiKey: 'new-key' })
      ).toThrow('rename denied')
      expect(readKaneoCredential()).toEqual(existing ? credential : null)
      expect(getKaneoStatus()).toEqual(
        existing
          ? { connected: true, siteUrl: credential.siteUrl }
          : { connected: false, siteUrl: null }
      )
      expect(readdirSync(join(home.path, '.orca')).sort()).toEqual(
        existing ? ['kaneo.enc', 'kaneo.json'] : []
      )
    }
  )
})
