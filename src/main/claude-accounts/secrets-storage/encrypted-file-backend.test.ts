import { describe, expect, it, beforeEach, vi } from 'vitest'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEncryptedFileBackend, resetEncryptedSecretsFile } from './encrypted-file-backend'
import { createPassphraseHolder } from './passphrase-prompt'

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-efb-'))
  path = join(dir, 'secrets.enc')
})

function backendWithPassphrase(pass: string) {
  const holder = createPassphraseHolder()
  holder.set(pass)
  const prompt = vi.fn<(opts: { mode: 'unlock' | 'create' }) => Promise<string | null>>(
    async () => pass
  )
  return createEncryptedFileBackend({
    filePath: path,
    holder,
    promptForPassphrase: async (opts) => prompt(opts as { mode: 'unlock' | 'create' })
  })
}

describe('encrypted-file-backend', () => {
  it('backendId === "encrypted-file"', () => {
    expect(backendWithPassphrase('p').backendId).toBe('encrypted-file')
  })

  it('write then read round-trips a secret', async () => {
    const b = backendWithPassphrase('hunter2')
    await b.write('svc', 'acct', 'sk-ant-abc')
    expect(await b.read('svc', 'acct')).toBe('sk-ant-abc')
  })

  it('read returns null when no such record', async () => {
    const b = backendWithPassphrase('hunter2')
    await b.write('svc', 'acct', 'val')
    expect(await b.read('svc', 'other')).toBeNull()
  })

  it('write overwrites existing record under same (service, account)', async () => {
    const b = backendWithPassphrase('hunter2')
    await b.write('svc', 'acct', 'v1')
    await b.write('svc', 'acct', 'v2')
    expect(await b.read('svc', 'acct')).toBe('v2')
  })

  it('delete removes the record', async () => {
    const b = backendWithPassphrase('hunter2')
    await b.write('svc', 'acct', 'v')
    await b.delete('svc', 'acct')
    expect(await b.read('svc', 'acct')).toBeNull()
  })

  it('delete on missing record is a no-op', async () => {
    const b = backendWithPassphrase('hunter2')
    await expect(b.delete('svc', 'missing')).resolves.toBeUndefined()
  })

  it('two records under same passphrase use distinct nonces and decrypt independently', async () => {
    const b = backendWithPassphrase('hunter2')
    await b.write('svc', 'a', 'val-a')
    await b.write('svc', 'b', 'val-b')
    expect(await b.read('svc', 'a')).toBe('val-a')
    expect(await b.read('svc', 'b')).toBe('val-b')
  })

  it('resetEncryptedSecretsFile removes file and clears holder', async () => {
    const b = backendWithPassphrase('hunter2')
    await b.write('svc', 'acct', 'val')
    expect(existsSync(path)).toBe(true)
    const holder = createPassphraseHolder()
    holder.set('hunter2')
    await resetEncryptedSecretsFile({ filePath: path, holder })
    expect(existsSync(path)).toBe(false)
    expect(holder.get()).toBeNull()
  })

  it('resetEncryptedSecretsFile is a no-op when file does not exist', async () => {
    const holder = createPassphraseHolder()
    holder.set('x')
    const missing = join(dir, 'never-written.enc')
    await expect(resetEncryptedSecretsFile({ filePath: missing, holder })).resolves.toBeUndefined()
    expect(holder.get()).toBeNull()
  })

  it('throws when read called but passphrase prompt is cancelled', async () => {
    const holder = createPassphraseHolder()
    const b = createEncryptedFileBackend({
      filePath: path,
      holder,
      promptForPassphrase: async () => null
    })
    // Pre-create a file so the read path needs to load and prompt for unlock.
    const pre = createEncryptedFileBackend({
      filePath: path,
      holder: (() => {
        const h = createPassphraseHolder()
        h.set('seed')
        return h
      })(),
      promptForPassphrase: async () => 'seed'
    })
    await pre.write('svc', 'acct', 'v')
    await expect(b.read('svc', 'acct')).rejects.toThrow(/passphrase/i)
  })
})
