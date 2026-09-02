import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why a module mock and not chmod: an unreadable file has to be EACCES/EMFILE-shaped for every
// runner, and chmod 000 is simply readable when the suite runs as root. Why not vi.spyOn: node's
// ESM namespace is not configurable, so spying on readFile throws.
const { readFailure } = vi.hoisted(() => ({ readFailure: { error: null as Error | null } }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) =>
      readFailure.error ? Promise.reject(readFailure.error) : actual.readFile(...args)
  }
})

const { mkdtemp, readdir, readFile, rm, stat, writeFile } = await import('node:fs/promises')
import {
  getSshHostKeyStoreFile,
  isTrusted,
  loadTrustedHostKeys,
  matchTrustedHostKeys,
  storedKeyTypesForEndpoint,
  trustHostKey
} from './ssh-host-key-store'

/** A blob shaped like a real host key: length-prefixed algorithm name, then payload. */
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
  it('places the store beside the profile data file, not inside it', () => {
    expect(getSshHostKeyStoreFile(join('/profiles', 'p1', 'orca-data.json'))).toBe(
      join('/profiles', 'p1', 'ssh-host-keys.json')
    )
  })

  it('recognises a key it was told to trust', async () => {
    expect(await isTrusted(query(), storeFile)).toBe('unknown')

    const record = await trustHostKey(query(), storeFile)

    expect(record.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/)
    expect(await isTrusted(query(), storeFile)).toBe('match')
  })

  it('reports a different key for the same host, port and type as a mismatch', async () => {
    await trustHostKey(query(), storeFile)

    expect(await isTrusted(query({ key: ED25519_B }), storeFile)).toBe('mismatch')
  })

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

  it('scopes trust to the endpoint, so a second target naming the same host is already trusted', async () => {
    await trustHostKey(query({ host: 'build-01' }), storeFile)

    // A different Orca target, same machine — no target id is recorded anywhere.
    expect(await isTrusted(query({ host: 'BUILD-01' }), storeFile)).toBe('match')
    const [record] = await loadTrustedHostKeys(storeFile)
    expect(Object.keys(record ?? {})).toEqual([
      'host',
      'port',
      'keyType',
      'key',
      'fingerprint',
      'acceptedAt'
    ])
  })

  it('does not carry trust across ports', async () => {
    await trustHostKey(query(), storeFile)

    expect(await isTrusted(query({ port: 2222 }), storeFile)).toBe('unknown')
  })

  it('trusts nothing when the file is missing', async () => {
    expect(await loadTrustedHostKeys(storeFile)).toEqual([])
    expect(await isTrusted(query(), storeFile)).toBe('unknown')
  })

  it('trusts nothing and does not throw when the file is corrupt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await writeFile(storeFile, '{"version":1,"hostKeys":[{"host":"build-01"', 'utf-8')

    await expect(loadTrustedHostKeys(storeFile)).resolves.toEqual([])
    await expect(isTrusted(query(), storeFile)).resolves.toBe('unknown')
    expect(warn).toHaveBeenCalled()
  })

  it('trusts nothing when the file parses but is not a store', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await writeFile(storeFile, '"everything"', 'utf-8')

    await expect(isTrusted(query(), storeFile)).resolves.toBe('unknown')
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
    // A crash mid-write, had it landed on the final path: valid JSON prefix, truncated.
    await writeFile(storeFile, whole.slice(0, Math.floor(whole.length / 2)), 'utf-8')

    await expect(isTrusted(query(), storeFile)).resolves.toBe('unknown')
    await expect(loadTrustedHostKeys(storeFile)).resolves.toEqual([])
  })

  it('leaves no temp file behind and keeps the store parseable after a write', async () => {
    await trustHostKey(query(), storeFile)

    expect(JSON.parse(await readFile(storeFile, 'utf-8'))).toMatchObject({
      version: 1
    })
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('publishes every update by replacing the file, never by rewriting it in place', async () => {
    await trustHostKey(query(), storeFile)
    const before = await stat(storeFile)

    await trustHostKey(query({ keyType: 'ssh-rsa', key: RSA_A }), storeFile)

    // A temp-file + rename swaps the inode; an in-place write truncates and keeps it, which is the
    // shape that can leave a half-written trust list readable after a crash.
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

  it('refuses to answer before the store is bound to a profile', async () => {
    await expect(isTrusted(query())).rejects.toThrow(/initSshHostKeyStoreFile/)
  })

  // The connect path cannot await the file — ssh2's verifier decides synchronously — so it matches
  // against preloaded records with this. It must reach the same verdict as isTrusted, because a
  // second copy of the comparison is exactly how the type downgrade got in.
  describe('matching preloaded records', () => {
    it('agrees with isTrusted on every outcome', async () => {
      await trustHostKey(query(), storeFile)
      await trustHostKey(query({ host: 'other-host', keyType: 'ssh-rsa', key: RSA_A }), storeFile)
      const records = await loadTrustedHostKeys(storeFile)

      for (const candidate of [
        query(),
        query({ key: ED25519_B }),
        query({ keyType: 'ssh-rsa', key: RSA_A }),
        query({ host: 'unheard-of' }),
        query({ port: 2222 }),
        query({ host: 'other-host', keyType: 'ssh-rsa', key: RSA_A })
      ]) {
        expect(matchTrustedHostKeys(records, candidate)).toBe(await isTrusted(candidate, storeFile))
      }
    })

    // trustHostKey normalises the host it writes, so the read has to normalise identically or it
    // never finds its own record: every connection is first contact and the store grows a row each
    // time while protecting nothing.
    it('normalises the query host the same way the write did', async () => {
      await trustHostKey(query({ host: '  Build-01  ' }), storeFile)
      const records = await loadTrustedHostKeys(storeFile)

      expect(records[0]?.host).toBe('build-01')
      expect(matchTrustedHostKeys(records, query({ host: '  BUILD-01 ' }))).toBe('match')
      expect(matchTrustedHostKeys(records, query({ host: 'build-01' }))).toBe('match')
    })
  })

  // Feeds the algorithm ordering: without the types we hold, a host known only to us is proposed
  // ed25519-first and an attacker can present another type to turn a hard failure into first contact.
  describe('the key types held for one endpoint', () => {
    it('reports every type recorded for that host and port', async () => {
      await trustHostKey(query(), storeFile)
      await trustHostKey(query({ keyType: 'ssh-rsa', key: RSA_A }), storeFile)
      const records = await loadTrustedHostKeys(storeFile)

      expect(storedKeyTypesForEndpoint(records, 'build-01', 22).sort()).toEqual([
        'ssh-ed25519',
        'ssh-rsa'
      ])
    })

    it('does not leak types from another port or host', async () => {
      await trustHostKey(query(), storeFile)
      const records = await loadTrustedHostKeys(storeFile)

      expect(storedKeyTypesForEndpoint(records, 'build-01', 2222)).toEqual([])
      expect(storedKeyTypesForEndpoint(records, 'build-02', 22)).toEqual([])
    })

    it('normalises the host it is asked about', async () => {
      await trustHostKey(query(), storeFile)
      const records = await loadTrustedHostKeys(storeFile)

      expect(storedKeyTypesForEndpoint(records, ' BUILD-01 ', 22)).toEqual(['ssh-ed25519'])
    })
  })
})

/**
 * Rollback safety for a brand-new on-disk format.
 *
 * `version` was written and never read, so a store from a future Orca would have every record
 * dropped by validation and then be rewritten as v1 — the file silently losing whatever that version
 * knew. v1 is the only place this can be made safe, because v2 cannot retrofit it.
 */
describe('a host key store written by a newer version', () => {
  it('is not trusted and not overwritten', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-host-key-store-'))
    const storeFile = join(dir, 'ssh-host-keys.json')
    const future = JSON.stringify({
      version: 99,
      hostKeys: [{ shape: 'we do not understand' }]
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
    // The shape that made this a data-loss bug rather than a lost prompt: one transient read failure
    // reported "nothing trusted", and the very next first-contact accept rewrote the file with ONLY
    // that record. Every other host then re-TOFUs, and one whose key genuinely changed in between is
    // accepted as first contact instead of refused — the exact outcome host key pinning prevents.
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

  it('still answers "nothing trusted" on the read path, so nothing fails open', async () => {
    // The two paths differ on purpose: a verifier that cannot read the store must fall back to a
    // first-contact prompt, never to trusting the key. Only the WRITE has to hold back.
    await trustHostKey(query(), storeFile)
    readFailure.error = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })

    expect(await loadTrustedHostKeys(storeFile)).toEqual([])
    expect(await isTrusted(query(), storeFile)).toBe('unknown')
  })
})
