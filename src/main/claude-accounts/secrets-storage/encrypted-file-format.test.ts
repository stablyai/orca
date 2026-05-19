import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEncryptedFile, writeEncryptedFile, recordKey } from './encrypted-file-format'
import type { EncryptedFileV1 } from './encrypted-file-format'

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-secrets-'))
  path = join(dir, 'secrets.enc')
})

describe('encrypted-file-format', () => {
  it('readEncryptedFile returns null when file is absent', async () => {
    expect(await readEncryptedFile(path)).toBeNull()
  })

  it('writeEncryptedFile + readEncryptedFile round-trips structure', async () => {
    const file: EncryptedFileV1 = {
      version: 1,
      saltHex: 'aa'.repeat(16),
      records: {
        [recordKey('svc', 'acct')]: {
          nonceHex: 'bb'.repeat(24),
          ciphertextHex: 'cc'.repeat(32)
        }
      }
    }
    await writeEncryptedFile(path, file)
    expect(await readEncryptedFile(path)).toEqual(file)
  })

  it('write is atomic: tmp + rename, mode 0600 on POSIX', async () => {
    const file: EncryptedFileV1 = { version: 1, saltHex: 'aa'.repeat(16), records: {} }
    await writeEncryptedFile(path, file)
    if (process.platform !== 'win32') {
      const mode = statSync(path).mode & 0o777
      expect(mode).toBe(0o600)
    }
    // sanity: file exists and contains valid JSON
    const raw = readFileSync(path, 'utf8')
    expect(JSON.parse(raw)).toMatchObject({ version: 1 })
  })

  it('readEncryptedFile throws on version mismatch', async () => {
    writeFileSync(path, JSON.stringify({ version: 99, saltHex: 'aa'.repeat(16), records: {} }))
    await expect(readEncryptedFile(path)).rejects.toThrow(/version/i)
  })

  it('recordKey escapes :: in service or account', () => {
    expect(recordKey('a::b', 'c')).toBe('a%3A%3Ab::c')
    expect(recordKey('a', 'b::c')).toBe('a::b%3A%3Ac')
  })
})
