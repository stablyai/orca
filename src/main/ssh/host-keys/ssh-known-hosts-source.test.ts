import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../config/ssh-g-config-resolution'
import { matchKnownHosts, readHostKeyType, type KnownHostsEntry } from './ssh-known-hosts'
import { loadKnownHostsEvidence, resolveKnownHostsFiles } from './ssh-known-hosts-source'

const ED_A = 'AAAAC3NzaC1lZDI1NTE5AAAAIKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'
const ED_B = 'AAAAC3NzaC1lZDI1NTE5AAAAILu7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7'
const ED_C = 'AAAAC3NzaC1lZDI1NTE5AAAAIMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM'

const blob = (base64: string): Buffer => Buffer.from(base64, 'base64')
const hostLine = (hosts: string, key: string): string => `${hosts} ssh-ed25519 ${key}\n`

function verdict(entries: KnownHostsEntry[], host: string, key: string): string {
  return matchKnownHosts(entries, {
    host,
    port: 22,
    keyType: readHostKeyType(blob(key)) ?? '',
    key: blob(key)
  })
}

const roots: string[] = []
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-known-hosts-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const key of ['HOME', 'USERPROFILE'] as const) {
    const value = savedHome[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

// The caller runs `matchKnownHosts` once over the union, so a hit in any file wins.
const loadKnownHostsEntries = async (files: readonly string[]): Promise<KnownHostsEntry[]> =>
  (await loadKnownHostsEvidence(files)).entries

describe('the union of known_hosts entries', () => {
  it('lets a hit in either file win over a disagreeing entry in the other', async () => {
    const root = await createRoot()
    const first = join(root, 'first')
    const second = join(root, 'second')
    await writeFile(first, hostLine('shared.example', ED_A))
    await writeFile(second, hostLine('shared.example', ED_B))

    const entries = await loadKnownHostsEntries([first, second])

    expect(verdict(entries, 'shared.example', ED_A)).toBe('match')
    expect(verdict(entries, 'shared.example', ED_B)).toBe('match')
    expect(verdict(entries, 'shared.example', ED_C)).toBe('mismatch')
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'skips an unreadable file and keeps the rest',
    async () => {
      const root = await createRoot()
      const unreadable = join(root, 'unreadable')
      const present = join(root, 'known_hosts')
      await writeFile(unreadable, hostLine('secret.example', ED_B))
      await chmod(unreadable, 0o000)
      await writeFile(present, hostLine('alpha.example', ED_A))

      const entries = await loadKnownHostsEntries([unreadable, present])

      expect(verdict(entries, 'alpha.example', ED_A)).toBe('match')
      expect(verdict(entries, 'secret.example', ED_B)).toBe('unknown')
    }
  )
})

// Distinguish normal absence from withheld evidence in an existing unreadable source.
describe('loadKnownHostsEvidence', () => {
  // A new profile has no known_hosts yet; absence is not unreadable evidence.
  it('does not count an absent file as unreadable', async () => {
    const root = await createRoot()

    const evidence = await loadKnownHostsEvidence([
      join(root, 'known_hosts'),
      join(root, 'known_hosts2')
    ])

    expect(evidence.unreadableFileCount).toBe(0)
    expect(evidence.entries).toEqual([])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'counts a file that exists but will not open',
    async () => {
      const root = await createRoot()
      const unreadable = join(root, 'known_hosts')
      await writeFile(unreadable, hostLine('secret.example', ED_B))
      await chmod(unreadable, 0o000)

      const evidence = await loadKnownHostsEvidence([unreadable])

      expect(evidence.unreadableFileCount).toBe(1)
    }
  )
})

/** OpenSSH10.2p1 prints spaced trust paths unquoted; splitting can hide existing changed-key evidence as absent files. */
describe('a known_hosts path containing a space', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca known hosts '))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('rejoins a spaced path sitting alongside an ordinary one', async () => {
    // Rejoin spaced paths even beside an existing ordinary file.
    const spaced = join(dir, 'known_hosts')
    const ordinary = join(dir, 'other')
    await writeFile(spaced, '', 'utf-8')
    await writeFile(ordinary, '', 'utf-8')

    const resolved = await resolveKnownHostsFiles({
      userKnownHostsFiles: [...spaced.split(' '), ordinary],
      globalKnownHostsFiles: []
    } as never)

    expect(resolved).toEqual([spaced, ordinary])
  })

  it('leaves a genuine multi-file list alone', async () => {
    // Any fragment existing means these really are separate paths, not one shredded one.
    const real = join(dir, 'first')
    await writeFile(real, '', 'utf-8')

    const resolved = await resolveKnownHostsFiles({
      userKnownHostsFiles: [real, '/tmp/orca-does-not-exist-known-hosts'],
      globalKnownHostsFiles: []
    } as never)

    expect(resolved).toEqual([real, '/tmp/orca-does-not-exist-known-hosts'])
  })
})
