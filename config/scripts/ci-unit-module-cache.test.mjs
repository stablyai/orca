import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  finishModuleCache,
  moduleCacheIdentity,
  prepareModuleCache
} from './ci-unit-module-cache.mjs'

const temporary = []
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function options() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-unit-cache-identity-'))
  temporary.push(directory)
  return {
    root: directory,
    cacheRoot: directory,
    policyHash: 'a'.repeat(64),
    installedLockHash: 'b'.repeat(64),
    versions: { node: '24.21.0', bun: '1.4.3', vitest: '5.0.3' },
    shard: { index: 1, count: 5 },
    platform: 'linux',
    arch: 'arm64',
    nodeEnv: 'test',
    namespace: ''
  }
}

describe('persistent unit module cache boundary', () => {
  it('separates hosts, runtimes, config, lockfiles, roots, shards and experiments', () => {
    const original = options()
    const identity = moduleCacheIdentity(original)
    const anotherRoot = options().root
    for (const update of [
      { root: anotherRoot },
      { policyHash: 'c'.repeat(64) },
      { installedLockHash: 'd'.repeat(64) },
      { platform: 'win32' },
      { arch: 'x64' },
      { nodeEnv: 'production' },
      { namespace: 'comparison' },
      { shard: { index: 2, count: 5 } },
      { shard: { index: 1, count: 10 } },
      { versions: { ...original.versions, node: '26.6.0' } },
      { versions: { ...original.versions, bun: '1.4.4' } },
      { versions: { ...original.versions, vitest: '5.0.4' } }
    ]) {
      const next = moduleCacheIdentity({ ...original, ...update })
      expect(next.key).not.toBe(identity.key)
      expect(next.path).toBe(identity.path)
    }
    expect(moduleCacheIdentity(original)).toEqual(identity)
  })

  it.each([
    { cacheRoot: '' },
    { policyHash: '' },
    { installedLockHash: '' },
    { versions: { node: '24', bun: '1.4.3', vitest: '5.0.3' } },
    { shard: { index: 0, count: 5 } },
    { shard: { index: 6, count: 5 } }
  ])('refuses an incomplete identity %j', (update) => {
    expect(() => moduleCacheIdentity({ ...options(), ...update })).toThrow('incomplete')
  })

  it.each([false, true])(
    'starts cold and discards unusable restored bytes (hit %s)',
    async (hit) => {
      const identity = moduleCacheIdentity(options())
      mkdirSync(identity.path)
      writeFileSync(join(identity.path, 'untrusted'), 'throw Error("must not execute")')
      const prepared = await prepareModuleCache(identity, { restoreHit: hit })
      expect(prepared.available).toBe(false)
      expect(prepared.validationMs).toBeGreaterThanOrEqual(0)
      expect(() => readFileSync(join(identity.path, 'untrusted'))).toThrow()
    }
  )
  it('restores a matching cache produced from an earlier source', async () => {
    const identity = moduleCacheIdentity(options())
    mkdirSync(identity.path)
    writeFileSync(
      join(identity.path, '_metadata.json'),
      JSON.stringify({ lockfileHash: identity.installedLockHash.slice(0, 8) })
    )
    const metadata = [
      { id: '1', url: '2', file: '1', imports: '3', mappings: false },
      join(identity.root, 'source.ts'),
      '/source.ts',
      { urls: '4', ids: '5' },
      [],
      {}
    ]
    writeFileSync(
      join(identity.path, 'a'.repeat(40)),
      `export const value = 1\n//# vitestCache=${Buffer.from(JSON.stringify(metadata)).toString('base64')}`
    )
    const produced = await finishModuleCache(identity, { sourceSha: 'a'.repeat(40) })
    expect(produced.entries).toBe(2)
    const prepared = await prepareModuleCache(
      { ...identity, sourceSha: 'b'.repeat(40) },
      { restoreHit: true }
    )
    expect(prepared).toMatchObject({
      available: true,
      entries: produced.entries,
      bytes: produced.bytes,
      producerSourceSha: 'a'.repeat(40)
    })
  })
})
