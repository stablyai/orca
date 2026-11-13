import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { moduleCacheIdentity, prepareModuleCache } from './ci-unit-module-cache.mjs'

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
  it('discards unusable restored cache bytes', async () => {
    const identity = moduleCacheIdentity(options())
    mkdirSync(identity.path)
    writeFileSync(join(identity.path, 'untrusted'), 'throw Error("must not execute")')
    await prepareModuleCache(identity, { restoreHit: true })
    expect(existsSync(join(identity.path, 'untrusted'))).toBe(false)
  })
})
