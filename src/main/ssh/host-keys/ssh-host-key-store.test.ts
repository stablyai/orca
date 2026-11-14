import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  await rm(directory, { recursive: true, force: true })
})

describe('ssh host key store', () => {
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
