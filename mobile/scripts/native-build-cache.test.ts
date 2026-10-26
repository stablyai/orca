import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import nativeBuildCache from './native-build-cache.cjs'

let cacheDir: string
let buildDir: string

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-build-cache-'))
  cacheDir = path.join(root, 'cache')
  buildDir = path.join(root, 'build')
  fs.mkdirSync(buildDir)
  vi.stubEnv(nativeBuildCache.CACHE_DIR_ENV, cacheDir)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function fakeAppBundle(name: string): string {
  const app = path.join(buildDir, name)
  fs.mkdirSync(app)
  fs.writeFileSync(path.join(app, 'Info.plist'), name)
  return app
}

describe('the Expo build cache provider', () => {
  const request = { platform: 'ios', fingerprintHash: 'abc', runOptions: {}, projectRoot: '/p' }

  it('only stores when native-client regenerated the native project for this fingerprint', async () => {
    const app = fakeAppBundle('Orca.app')
    await nativeBuildCache.uploadBuildCache({ ...request, buildPath: app })
    expect(await nativeBuildCache.resolveBuildCache(request)).toBeNull()

    vi.stubEnv(nativeBuildCache.CACHE_MODE_ENV, 'store')
    await nativeBuildCache.uploadBuildCache({ ...request, buildPath: app })
    // Store mode is a forced rebuild, so it must not short-circuit to the entry it is replacing.
    expect(await nativeBuildCache.resolveBuildCache(request)).toBeNull()

    vi.stubEnv(nativeBuildCache.CACHE_MODE_ENV, '')
    const cached = await nativeBuildCache.resolveBuildCache(request)
    expect(cached).toBe(path.join(cacheDir, 'ios-abc-Debug', 'Orca.app'))
    expect(fs.readFileSync(path.join(cached!, 'Info.plist'), 'utf8')).toBe('Orca.app')
  })

  it('keys by variant, so a Release build never satisfies a Debug lookup', async () => {
    vi.stubEnv(nativeBuildCache.CACHE_MODE_ENV, 'store')
    const release = { ...request, runOptions: { configuration: 'Release' } }
    await nativeBuildCache.uploadBuildCache({ ...release, buildPath: fakeAppBundle('Orca.app') })
    vi.stubEnv(nativeBuildCache.CACHE_MODE_ENV, '')
    expect(await nativeBuildCache.resolveBuildCache(request)).toBeNull()
    expect(await nativeBuildCache.resolveBuildCache(release)).not.toBeNull()
  })
})

describe('cache pruning', () => {
  it('keeps the most recently used entries per platform and leaves other platforms alone', () => {
    for (const [index, key] of [
      'android-a-debug',
      'android-b-debug',
      'android-c-debug',
      'android-d-debug',
      'ios-z-Debug'
    ].entries()) {
      const entryDir = path.join(cacheDir, key)
      fs.mkdirSync(entryDir, { recursive: true })
      fs.writeFileSync(path.join(entryDir, 'app-debug.apk'), key)
      const time = new Date(Date.now() - (10 - index) * 60_000)
      fs.utimesSync(entryDir, time, time)
    }
    // A lookup refreshes the entry, so `a` survives the next prune instead of `b`.
    nativeBuildCache.findCachedBuild(cacheDir, 'android-a-debug')

    expect(nativeBuildCache.pruneCache(cacheDir, 'android', 3)).toEqual(['android-b-debug'])
    expect(fs.readdirSync(cacheDir).sort()).toEqual([
      'android-a-debug',
      'android-c-debug',
      'android-d-debug',
      'ios-z-Debug'
    ])
  })
})
