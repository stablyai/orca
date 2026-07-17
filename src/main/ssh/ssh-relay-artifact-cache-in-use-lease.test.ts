import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSshRelayArtifactCacheEvictionFixture } from './ssh-relay-artifact-cache-eviction-fixture'
import { evictSshRelayArtifactCache } from './ssh-relay-artifact-cache-eviction'
import {
  acquireSshRelayArtifactCacheInUseLease,
  sshRelayArtifactCacheInUseLeasePath,
  SSH_RELAY_ARTIFACT_CACHE_IN_USE_LIMITS
} from './ssh-relay-artifact-cache-in-use-lease'
import type { SshRelayDigest } from './ssh-relay-runtime-identity'

const temporaryDirectories: string[] = []
const leaseModuleUrl = pathToFileURL(
  join(import.meta.dirname, 'ssh-relay-artifact-cache-in-use-lease.ts')
).href

async function cacheRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-relay-cache-in-use-'))
  temporaryDirectories.push(root)
  return join(root, 'cache')
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('SSH relay artifact cache in-use lease', () => {
  it('pins exact paths and bounded heartbeat/stale timing', async () => {
    const root = await cacheRoot()
    const { entry } = await createSshRelayArtifactCacheEvictionFixture({
      cacheRoot: root,
      character: 'a'
    })
    const token = 'b'.repeat(32)
    expect(sshRelayArtifactCacheInUseLeasePath(root, entry.contentId, token)).toBe(
      join(root, 'in-use', 'a'.repeat(64), `${token}.lease`)
    )
    expect(SSH_RELAY_ARTIFACT_CACHE_IN_USE_LIMITS).toEqual({
      heartbeatIntervalMs: 5_000,
      staleAfterMs: 30_000,
      acquisitionTimeoutMs: 120_000
    })
    expect(Object.isFrozen(SSH_RELAY_ARTIFACT_CACHE_IN_USE_LIMITS)).toBe(true)
    for (const invalid of [
      `sha256:${'A'.repeat(64)}`,
      `sha256:${'a'.repeat(63)}`,
      `${entry.contentId}/../escape`
    ]) {
      expect(() =>
        sshRelayArtifactCacheInUseLeasePath(root, invalid as SshRelayDigest, token)
      ).toThrow(/content id/i)
    }
    expect(() => sshRelayArtifactCacheInUseLeasePath(root, entry.contentId, '../escape')).toThrow(
      /token/i
    )
  })

  it('allows multiple references and heartbeats owner records independently', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const root = await cacheRoot()
    const { entry } = await createSshRelayArtifactCacheEvictionFixture({
      cacheRoot: root,
      character: 'a'
    })
    const first = await acquireSshRelayArtifactCacheInUseLease({ cacheRoot: root, entry })
    const second = await acquireSshRelayArtifactCacheInUseLease({ cacheRoot: root, entry })
    expect(second.token).not.toBe(first.token)

    await vi.advanceTimersByTimeAsync(5_000)
    await first.assertOwned()
    const owner = JSON.parse(await readFile(join(first.leasePath, 'owner.json'), 'utf8')) as {
      heartbeatAtMs: number
    }
    expect(owner.heartbeatAtMs).toBe(105_000)
    await Promise.all([first.release(), second.release()])
    expect(await readdir(join(root, 'recency', entry.contentId.slice(7)))).toHaveLength(1)
  })

  it('does not delete a displaced successor through owner release', async () => {
    const root = await cacheRoot()
    const { entry } = await createSshRelayArtifactCacheEvictionFixture({
      cacheRoot: root,
      character: 'a'
    })
    const lease = await acquireSshRelayArtifactCacheInUseLease({ cacheRoot: root, entry })
    const successor = { token: 'c'.repeat(32) }
    const owner = JSON.parse(await readFile(join(lease.leasePath, 'owner.json'), 'utf8')) as object
    await writeFile(
      join(lease.leasePath, 'owner.json'),
      `${JSON.stringify({ ...owner, ...successor })}\n`
    )

    await expect(lease.assertOwned()).rejects.toThrow(/ownership/i)
    await lease.release()
    await expect(stat(lease.leasePath)).resolves.toMatchObject({
      isDirectory: expect.any(Function)
    })
  })

  it('makes a live lease visible to a real second process', async () => {
    const root = await cacheRoot()
    const { entry } = await createSshRelayArtifactCacheEvictionFixture({
      cacheRoot: root,
      character: 'a'
    })
    const script = `
      import { registerHooks } from 'node:module'
      registerHooks({ resolve(specifier, context, nextResolve) {
        try { return nextResolve(specifier, context) }
        catch (error) { if (specifier.startsWith('.')) return nextResolve(specifier + '.ts', context); throw error }
      } })
      const { acquireSshRelayArtifactCacheInUseLease } = await import(${JSON.stringify(leaseModuleUrl)})
      const entry = JSON.parse(process.env.ORCA_RELAY_CACHE_ENTRY)
      const lease = await acquireSshRelayArtifactCacheInUseLease({ cacheRoot: process.env.ORCA_RELAY_CACHE_ROOT, entry })
      process.stdout.write(lease.leasePath + '\\n')
      await new Promise(resolve => process.stdin.once('data', resolve))
      await lease.release()
    `
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        '--input-type=module',
        '--eval',
        script
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ORCA_RELAY_CACHE_ROOT: root,
          ORCA_RELAY_CACHE_ENTRY: JSON.stringify(entry)
        },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    let childError = ''
    child.stderr.on('data', (bytes: Buffer) => (childError += bytes.toString('utf8')))
    const leasePath = await new Promise<string>((resolve, reject) => {
      child.once('error', reject)
      child.stdout.once('data', (bytes: Buffer) => resolve(bytes.toString('utf8').trim()))
      child.once('exit', (code) => reject(new Error(`Lease child exited ${code}: ${childError}`)))
    })
    await expect(stat(leasePath)).resolves.toMatchObject({ isDirectory: expect.any(Function) })
    const retained = await evictSshRelayArtifactCache({ cacheRoot: root, maximumBytes: 0 })
    expect(retained.evictedContentIds).toEqual([])
    child.stdin.end('release\n')
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve))
    expect(code).toBe(0)
  })

  it('rejects a reference when the exact final entry no longer exists', async () => {
    const root = await cacheRoot()
    const { entry } = await createSshRelayArtifactCacheEvictionFixture({
      cacheRoot: root,
      character: 'a'
    })
    await rm(entry.entryPath, { recursive: true })
    await expect(
      acquireSshRelayArtifactCacheInUseLease({ cacheRoot: root, entry })
    ).rejects.toThrow(/entry/i)
    const misplacedEntryPath = join(root, 'entries', 'b'.repeat(64))
    await mkdir(misplacedEntryPath, { recursive: true })
    await expect(
      acquireSshRelayArtifactCacheInUseLease({
        cacheRoot: root,
        entry: { ...entry, entryPath: misplacedEntryPath }
      })
    ).rejects.toThrow(/identity/i)
    await mkdir(join(root, 'in-use'), { recursive: true })
    expect(sshRelayArtifactCacheInUseLeasePath(root, entry.contentId, 'd'.repeat(32))).toContain(
      join('in-use', 'a'.repeat(64))
    )
  })
})
