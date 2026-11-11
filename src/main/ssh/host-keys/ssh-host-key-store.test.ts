import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock read failures for consistent EACCES/EMFILE even as root; ESM namespaces cannot be spied on with readFile.
const { readFailure } = vi.hoisted(() => ({ readFailure: { error: null as Error | null } }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) =>
      readFailure.error ? Promise.reject(readFailure.error) : actual.readFile(...args)
  }
})

const { mkdtemp, readFile, rm, stat, writeFile } = await import('node:fs/promises')
import {
  getSshHostKeyStoreFile,
  isTrusted,
  loadTrustedHostKeys,
  trustHostKey
} from './ssh-host-key-store'

function hostKey(keyType: string, seed: string): Buffer {
  const name = Buffer.from(keyType, 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(name.length, 0)
  return Buffer.concat([length, name, Buffer.from(seed.padEnd(32, '.'), 'utf8')])
}

const ED25519_A = hostKey('ssh-ed25519', 'key-a')
const ED25519_B = hostKey('ssh-ed25519', 'key-b')
const RSA_A = hostKey('ssh-rsa', 'rsa-a')

function query(overrides: Partial<Parameters<typeof isTrusted>[0]> = {}) {
  return {
    host: 'build-01',
    port: 22,
    keyType: 'ssh-ed25519',
    key: ED25519_A,
    ...overrides
  }
}

let directory: string
let storeFile: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-host-key-store-'))
  storeFile = getSshHostKeyStoreFile(join(directory, 'orca-data.json'))
})

afterEach(async () => {
  readFailure.error = null
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

describe('ssh host key store', () => {
  it('supersedes the stored key when the same triple is trusted again', async () => {
    await trustHostKey(query(), storeFile)
    await trustHostKey(query({ key: ED25519_B }), storeFile)

    expect(await loadTrustedHostKeys(storeFile)).toHaveLength(1)
    expect(await isTrusted(query({ key: ED25519_B }), storeFile)).toBe('match')
    expect(await isTrusted(query(), storeFile)).toBe('mismatch')
  })

  it('keeps a second key type for the same host alongside the first', async () => {
    await trustHostKey(query(), storeFile)
    await trustHostKey(query({ keyType: 'ssh-rsa', key: RSA_A }), storeFile)

    expect(await loadTrustedHostKeys(storeFile)).toHaveLength(2)
    expect(await isTrusted(query(), storeFile)).toBe('match')
    expect(await isTrusted(query({ keyType: 'ssh-rsa', key: RSA_A }), storeFile)).toBe('match')
  })

  it('treats an unrecorded key type for a known host as suspicious, not first contact', async () => {
    await trustHostKey(query({ keyType: 'ssh-rsa', key: RSA_A }), storeFile)

    expect(await isTrusted(query(), storeFile)).toBe('unknown-type-known-host')
  })

  it('does not carry trust across ports', async () => {
    await trustHostKey(query(), storeFile)

    expect(await isTrusted(query({ port: 2222 }), storeFile)).toBe('unknown')
  })

  it('drops a record whose key does not carry the type it claims', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await trustHostKey(query(), storeFile)
    const stored = JSON.parse(await readFile(storeFile, 'utf-8')) as {
      hostKeys: { keyType: string }[]
    }
    stored.hostKeys[0]!.keyType = 'ssh-rsa'
    await writeFile(storeFile, JSON.stringify(stored), 'utf-8')

    expect(await loadTrustedHostKeys(storeFile)).toEqual([])
    expect(await isTrusted(query({ keyType: 'ssh-rsa' }), storeFile)).toBe('unknown')
  })

  it('drops a record whose fingerprint disagrees with its key', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await trustHostKey(query(), storeFile)
    const stored = JSON.parse(await readFile(storeFile, 'utf-8')) as {
      hostKeys: { fingerprint: string }[]
    }
    stored.hostKeys[0]!.fingerprint = 'SHA256:not-the-key'
    await writeFile(storeFile, JSON.stringify(stored), 'utf-8')

    expect(await isTrusted(query(), storeFile)).toBe('unknown')
  })

  it('never publishes a half-written store: a torn payload trusts nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await trustHostKey(query(), storeFile)
    const whole = await readFile(storeFile, 'utf-8')
    // Model a crash-truncated final file with a valid JSON prefix.
    await writeFile(storeFile, whole.slice(0, Math.floor(whole.length / 2)), 'utf-8')

    await expect(isTrusted(query(), storeFile)).resolves.toBe('unknown')
    await expect(loadTrustedHostKeys(storeFile)).resolves.toEqual([])
  })

  it('publishes every update by replacing the file, never by rewriting it in place', async () => {
    await trustHostKey(query(), storeFile)
    const before = await stat(storeFile)

    await trustHostKey(query({ keyType: 'ssh-rsa', key: RSA_A }), storeFile)

    // Atomic rename changes inode; in-place truncation risks a readable partial trust file after crash.
    const after = await stat(storeFile)
    if (before.ino !== 0 && after.ino !== 0) {
      expect(after.ino).not.toBe(before.ino)
    }
    expect(await isTrusted(query(), storeFile)).toBe('match')
  })

  it('keeps both accepts when two hosts are trusted concurrently', async () => {
    await Promise.all([
      trustHostKey(query({ host: 'host-a' }), storeFile),
      trustHostKey(query({ host: 'host-b', key: ED25519_B }), storeFile)
    ])

    expect(await isTrusted(query({ host: 'host-a' }), storeFile)).toBe('match')
    expect(await isTrusted(query({ host: 'host-b', key: ED25519_B }), storeFile)).toBe('match')
  })
})

/** Reject and preserve unknown future store versions; treating them as empty then rewriting v1 would destroy newer trust records. */
describe('a host key store written by a newer version', () => {
  it('is not trusted and not overwritten', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-host-key-store-'))
    const storeFile = join(dir, 'ssh-host-keys.json')
    const future = JSON.stringify({
      version: 99,
      hostKeys: [{ unrecognized: 'we do not understand' }]
    })
    await writeFile(storeFile, future, 'utf-8')

    try {
      expect(await loadTrustedHostKeys(storeFile)).toEqual([])

      await trustHostKey(
        { host: 'build-01', port: 22, keyType: 'ssh-ed25519', key: Buffer.from('key') },
        storeFile
      )

      expect(await readFile(storeFile, 'utf-8'), 'a newer store was downgraded').toBe(future)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('a host key store that exists but cannot be read', () => {
  it('does not let the next accepted key wipe every other host on file', async () => {
    // A transient read failure must never rewrite the store with one new record and silently re-TOFU every other host.
    await trustHostKey(query({ host: 'build-01' }), storeFile)
    await trustHostKey(query({ host: 'build-02', key: ED25519_B }), storeFile)
    const before = await readFile(storeFile, 'utf-8')

    readFailure.error = Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' })
    await trustHostKey(query({ host: 'build-03', key: RSA_A, keyType: 'ssh-rsa' }), storeFile)
    readFailure.error = null

    expect(await readFile(storeFile, 'utf-8'), 'an unreadable store was overwritten').toBe(before)
    const kept = await loadTrustedHostKeys(storeFile)
    expect(kept.map((record) => record.host).sort()).toEqual(['build-01', 'build-02'])
  })
})
