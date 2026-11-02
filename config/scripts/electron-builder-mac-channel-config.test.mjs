import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')

const MUTABLE_BUILD_ENV = [
  'ORCA_MAC_HOURLY',
  'ORCA_MAC_DAILY',
  'ORCA_MAC_ADHOC',
  'ORCA_MAC_RELEASE',
  'ORCA_HOURLY_BUILD_VERSION',
  'ORCA_DAILY_BUILD_VERSION',
  'ORCA_ADHOC_BUILD_VERSION',
  'ORCA_LOCAL_BUILD_VERSION'
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

const withHourlyEnv = (assert) => withEnv({ ORCA_MAC_HOURLY: '1' }, assert)
const withDailyEnv = (assert) => withEnv({ ORCA_MAC_DAILY: '1' }, assert)
const withAdhocEnv = (assert) => withEnv({ ORCA_MAC_ADHOC: '1' }, assert)

describe('electron-builder mac channel config', () => {
  // Squirrel.Mac requires release bundle ID and Developer ID signature; local ad-hoc hourly identity cannot update real Orca.
  it('builds hourly artifacts with the release signing identity', () => {
    withHourlyEnv((config) => {
      expect(config.mac.appId).toBeUndefined()
      expect(config.appId).toBe('com.stablyai.orca')
      expect(config.mac.hardenedRuntime).toBe(true)
      expect(config.forceCodeSigning).toBe(true)
    })
  })

  // Notarization anchors TCC to identifier/team across updates; unnotarized hourlies lose folder grants without re-prompt.
  it('notarizes hourly builds like releases, and neither locally', () => {
    withHourlyEnv((config) => {
      expect(config.mac.notarize).toBe(true)
    })
    withEnv({ ORCA_MAC_RELEASE: '1' }, (config) => {
      expect(config.mac.notarize).toBe(true)
    })
    expect(electronBuilderConfig.mac.notarize).toBe(false)
  })

  // Twenty-four hourly releases would evict stable/RC from main repo’s ten-entry feed.
  it('publishes hourly builds to the separate hourly repo', () => {
    withHourlyEnv((config) => {
      expect(config.publish).toMatchObject({ repo: 'orca-hourly', releaseType: 'prerelease' })
    })
    expect(electronBuilderConfig.publish).toMatchObject({
      repo: 'orca',
      releaseType: 'draft'
    })
  })

  it('stamps hourly packages with the hourly version', () => {
    withEnv(
      { ORCA_MAC_HOURLY: '1', ORCA_HOURLY_BUILD_VERSION: '1.4.160-hourly.202607281400' },
      (config) => {
        expect(config.extraMetadata).toEqual({ version: '1.4.160-hourly.202607281400' })
      }
    )
  })

  // Adhoc uses same updater, signing and TCC identity as hourly; only destination repo differs.
  it('builds adhoc artifacts with the release identity and its own repo', () => {
    withAdhocEnv((config) => {
      expect(config.appId).toBe('com.stablyai.orca')
      expect(config.mac.hardenedRuntime).toBe(true)
      expect(config.mac.notarize).toBe(true)
      expect(config.forceCodeSigning).toBe(true)
      expect(config.publish).toMatchObject({ repo: 'orca-adhoc', releaseType: 'prerelease' })
    })
  })

  it('stamps adhoc packages with the adhoc version', () => {
    withEnv(
      { ORCA_MAC_ADHOC: '1', ORCA_ADHOC_BUILD_VERSION: '1.4.160-adhoc.20260728140533' },
      (config) => {
        expect(config.extraMetadata).toEqual({ version: '1.4.160-adhoc.20260728140533' })
      }
    )
  })

  it('builds daily artifacts with the release identity and its own repo', () => {
    withDailyEnv((config) => {
      expect(config.appId).toBe('com.stablyai.orca')
      expect(config.mac.hardenedRuntime).toBe(true)
      expect(config.mac.notarize).toBe(true)
      expect(config.forceCodeSigning).toBe(true)
      expect(config.publish).toMatchObject({ repo: 'orca-daily', releaseType: 'prerelease' })
    })
  })

  it('stamps daily packages with the daily version', () => {
    withEnv(
      { ORCA_MAC_DAILY: '1', ORCA_DAILY_BUILD_VERSION: '1.4.160-daily.202607281300' },
      (config) => {
        expect(config.extraMetadata).toEqual({ version: '1.4.160-daily.202607281300' })
      }
    )
  })
})
