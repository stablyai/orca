import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')

const MUTABLE_BUILD_ENV = [
  'MCODE_MAC_HOURLY',
  'MCODE_MAC_DAILY',
  'MCODE_MAC_ADHOC',
  'MCODE_MAC_RELEASE',
  'MCODE_HOURLY_BUILD_VERSION',
  'MCODE_DAILY_BUILD_VERSION',
  'MCODE_ADHOC_BUILD_VERSION',
  'MCODE_LOCAL_BUILD_VERSION'
]

/** Re-requires the config under a temporary env, then restores env and module cache. */
function withEnv(env, assert) {
  const configPath = require.resolve('../electron-builder.config.cjs')
  const original = Object.fromEntries(MUTABLE_BUILD_ENV.map((key) => [key, process.env[key]]))
  try {
    for (const key of MUTABLE_BUILD_ENV) {
      delete process.env[key]
    }
    Object.assign(process.env, env)
    delete require.cache[configPath]
    assert(require('../electron-builder.config.cjs'))
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    delete require.cache[configPath]
    require('../electron-builder.config.cjs')
  }
}

const withHourlyEnv = (assert) => withEnv({ MCODE_MAC_HOURLY: '1' }, assert)
const withDailyEnv = (assert) => withEnv({ MCODE_MAC_DAILY: '1' }, assert)
const withAdhocEnv = (assert) => withEnv({ MCODE_MAC_ADHOC: '1' }, assert)

describe('electron-builder mac channel config', () => {
  // Why: Squirrel.Mac swaps the .app in place only when the replacement carries the
  // same bundle id and a valid Developer ID signature. A hourly built on the local
  // (com.mcode.desktop.local, ad-hoc) identity would be un-installable over a real
  // MCode — the whole point of the channel.
  it('builds hourly artifacts with the release signing identity', () => {
    withHourlyEnv((config) => {
      expect(config.mac.appId).toBeUndefined()
      expect(config.appId).toBe('com.mcode.desktop')
      expect(config.mac.hardenedRuntime).toBe(true)
      expect(config.forceCodeSigning).toBe(true)
    })
  })

  // Why hourly must notarize despite the round trip: TCC anchors a notarized
  // Developer ID app's grants on identifier + team, not on its cdhash, so they
  // survive an update. An unnotarized hourly reads as a new client every build
  // and loses file access under Documents/Desktop/Downloads with no re-prompt.
  it('notarizes hourly builds like releases, and neither locally', () => {
    withHourlyEnv((config) => {
      expect(config.mac.notarize).toBe(true)
    })
    withEnv({ MCODE_MAC_RELEASE: '1' }, (config) => {
      expect(config.mac.notarize).toBe(true)
    })
    expect(electronBuilderConfig.mac.notarize).toBe(false)
  })

  // Why: the main repo's releases atom feed exposes only its 10 newest entries.
  // Publishing 24 hourly tags a day there would evict every stable/RC entry and
  // break update checks for every real user.
  it('publishes hourly builds to the separate hourly repo', () => {
    withHourlyEnv((config) => {
      expect(config.publish).toMatchObject({ repo: 'mcode-hourly', releaseType: 'prerelease' })
    })
    expect(electronBuilderConfig.publish).toMatchObject({
      repo: 'mcode',
      releaseType: 'release'
    })
  })

  it('stamps hourly packages with the hourly version', () => {
    withEnv(
      { MCODE_MAC_HOURLY: '1', MCODE_HOURLY_BUILD_VERSION: '1.4.160-hourly.202607281400' },
      (config) => {
        expect(config.extraMetadata).toEqual({ version: '1.4.160-hourly.202607281400' })
      }
    )
  })

  // Why adhoc carries the identical mac identity to hourly: it installs over a
  // real MCode through the same updater path, so the same signing and the same TCC
  // argument apply. Only the destination repo differs.
  it('builds adhoc artifacts with the release identity and its own repo', () => {
    withAdhocEnv((config) => {
      expect(config.appId).toBe('com.mcode.desktop')
      expect(config.mac.hardenedRuntime).toBe(true)
      expect(config.mac.notarize).toBe(true)
      expect(config.forceCodeSigning).toBe(true)
      expect(config.publish).toMatchObject({ repo: 'mcode-adhoc', releaseType: 'prerelease' })
    })
  })

  it('stamps adhoc packages with the adhoc version', () => {
    withEnv(
      { MCODE_MAC_ADHOC: '1', MCODE_ADHOC_BUILD_VERSION: '1.4.160-adhoc.20260728140533' },
      (config) => {
        expect(config.extraMetadata).toEqual({ version: '1.4.160-adhoc.20260728140533' })
      }
    )
  })

  it('builds daily artifacts with the release identity and its own repo', () => {
    withDailyEnv((config) => {
      expect(config.appId).toBe('com.mcode.desktop')
      expect(config.mac.hardenedRuntime).toBe(true)
      expect(config.mac.notarize).toBe(true)
      expect(config.forceCodeSigning).toBe(true)
      expect(config.publish).toMatchObject({ repo: 'mcode-daily', releaseType: 'prerelease' })
    })
  })

  it('stamps daily packages with the daily version', () => {
    withEnv(
      { MCODE_MAC_DAILY: '1', MCODE_DAILY_BUILD_VERSION: '1.4.160-daily.202607281300' },
      (config) => {
        expect(config.extraMetadata).toEqual({ version: '1.4.160-daily.202607281300' })
      }
    )
  })

  // Why: the dev channels share every packaging decision except where they
  // publish, so a future edit that collapses them must not also collapse the
  // repos — a branch or daily build landing in mcode-hourly would be offered to
  // everyone riding main's hourlies.
  it('keeps the dev channels on separate repos', () => {
    withHourlyEnv((hourly) => {
      withDailyEnv((daily) => {
        withAdhocEnv((adhoc) => {
          expect(new Set([hourly.publish.repo, daily.publish.repo, adhoc.publish.repo]).size).toBe(
            3
          )
        })
      })
    })
  })
})
