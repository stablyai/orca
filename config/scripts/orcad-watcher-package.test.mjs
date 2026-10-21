import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  parseWatcherLockfile,
  verifyWatcherArchive,
  watcherPackageIdentity
} from './orcad-watcher-package.mjs'

describe('locked watcher release assets', () => {
  const archive = Buffer.from('archive')
  const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`

  it('reads dependency pins after the package-manager document in pnpm 12 lockfiles', () => {
    const lockfile = parseWatcherLockfile(
      `---\npackages: {}\n---\npackages:\n  '@parcel/watcher-linux-x64-glibc@2.5.6':\n    resolution:\n      integrity: ${integrity}\n`
    )
    expect(watcherPackageIdentity('linux-x64-glibc', '2.5.6', lockfile).integrity).toBe(integrity)
  })

  it('resolves a target using the exact installed wrapper version and locked integrity', () => {
    const lockfile = {
      packages: { '@parcel/watcher-linux-x64-musl@2.5.6': { resolution: { integrity } } }
    }
    expect(watcherPackageIdentity('linux-x64-musl', '2.5.6', lockfile)).toEqual({
      integrity,
      url: 'https://registry.npmjs.org/@parcel/watcher-linux-x64-musl/-/watcher-linux-x64-musl-2.5.6.tgz'
    })
    expect(() => watcherPackageIdentity('linux-x64-glibc', '2.5.6', lockfile)).toThrow('lockfile')
    expect(() => watcherPackageIdentity('linux-x64-musl', '2.5.7', lockfile)).toThrow('lockfile')
  })

  it('rejects missing, unknown and corrupted inputs before extraction', () => {
    expect(() => watcherPackageIdentity('../x64', '2.5.6', {})).toThrow('Unsupported')
    expect(() => verifyWatcherArchive(archive, integrity)).not.toThrow()
    expect(() => verifyWatcherArchive(Buffer.from('tampered'), integrity)).toThrow('integrity')
    expect(() => verifyWatcherArchive(Buffer.alloc(16 * 1024 * 1024 + 1), integrity)).toThrow(
      'size limit'
    )
  })
})
