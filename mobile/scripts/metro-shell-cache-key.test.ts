import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * Metro's transform cache is what decides which shell a release bakes in.
 *
 * `babel-preset-expo` inlines `EXPO_PUBLIC_MOBILE_SHELL` into `mobileShellBuildKind` at transform
 * time, but nothing Metro hashes into the transform cache key carries that value, so a warm cache
 * seeded by the opposite kind returns the opposite shell byte for byte — and the absence of the
 * variable's name in the bundle cannot tell the two apart. `cacheVersion` is the one input to that
 * key a project owns.
 */
const MOBILE_ROOT = join(import.meta.dirname, '..')
const CONFIG_PATH = join(MOBILE_ROOT, 'metro.config.js')
const SWITCH = 'EXPO_PUBLIC_MOBILE_SHELL'
/** The one expression both the config and the app answer the build kind with. */
const BUILD_KIND_RULE = `process.env.${SWITCH} === 'ota' ? 'ota' : 'native'`
const APP_DEFINITION = join(MOBILE_ROOT, 'src', 'storage', 'preferences.ts')
const requireConfig = createRequire(import.meta.url)
const originalSwitch = process.env[SWITCH]

function cacheVersionOf(loaded: unknown): string {
  if (typeof loaded !== 'object' || loaded === null || !('cacheVersion' in loaded)) {
    throw new Error('metro.config.js exported no cacheVersion')
  }
  const { cacheVersion } = loaded
  if (typeof cacheVersion !== 'string') {
    throw new Error(`metro.config.js exported a non-string cacheVersion: ${typeof cacheVersion}`)
  }
  return cacheVersion
}

/** Re-evaluates the config, which is the only way the env read at its top level runs again. */
function cacheVersionFor(shell: string | undefined): string {
  if (shell === undefined) {
    Reflect.deleteProperty(process.env, SWITCH)
  } else {
    process.env[SWITCH] = shell
  }
  Reflect.deleteProperty(requireConfig.cache, requireConfig.resolve(CONFIG_PATH))
  return cacheVersionOf(requireConfig(CONFIG_PATH))
}

afterEach(() => {
  if (originalSwitch === undefined) {
    Reflect.deleteProperty(process.env, SWITCH)
  } else {
    process.env[SWITCH] = originalSwitch
  }
})

describe("metro's transform cache key", () => {
  it('separates the two shell kinds, so neither can be served a warm cache of the other', () => {
    expect(cacheVersionFor('ota')).not.toEqual(cacheVersionFor('native'))
  })

  it('reads the kind by the same rule the app applies, so the key names the shell it bakes', () => {
    const base = cacheVersionFor(undefined).replace(/-shell-native$/, '')

    expect(cacheVersionFor('ota')).toBe(`${base}-shell-ota`)
    expect(cacheVersionFor('native')).toBe(`${base}-shell-native`)
    // Every other value is a native build to the app, and so has to be one to the cache as well.
    expect(cacheVersionFor(undefined)).toBe(`${base}-shell-native`)
    expect(cacheVersionFor('')).toBe(`${base}-shell-native`)
    expect(cacheVersionFor('OTA')).toBe(`${base}-shell-native`)
    expect(cacheVersionFor('page')).toBe(`${base}-shell-native`)
  })

  it('spells that rule the same way the app does, so the two cannot drift apart silently', () => {
    // A copy is unavoidable: the config runs in Node at bundle time and the app module is a React
    // Native one, so neither can import the other. Pinning the spelling is what keeps them equal.
    for (const path of [CONFIG_PATH, APP_DEFINITION]) {
      const text = readFileSync(path, 'utf8')
      const line = text.split('\n').find((candidate) => candidate.includes(BUILD_KIND_RULE))

      expect(line, `${path} does not spell: ${BUILD_KIND_RULE}`).toBeDefined()
    }
  })

  it("keeps metro's own cache version, which invalidates on a bundler upgrade", () => {
    // Replacing it rather than extending it would trade this bug for that one.
    const defaultConfig: unknown = requireConfig('expo/metro-config').getDefaultConfig(MOBILE_ROOT)

    expect(cacheVersionFor('ota').startsWith(`${cacheVersionOf(defaultConfig)}-`)).toBe(true)
  })
})
