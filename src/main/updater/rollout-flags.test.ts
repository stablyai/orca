import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import {
  BAKED_ROLLOUT_FLAGS,
  ROLLOUT_FLAG_NAMES,
  isRolloutFlagActive,
  parseRolloutConfig,
  readE2ERolloutConfigOverride,
  recordRolloutConfig,
  resetRolloutConfigForTests,
  resolveRolloutFlag,
  rolloutBucket,
  type RolloutConfig
} from './rollout-flags'

const install = { appVersion: '1.5.0', installId: 'install-a' }

function campaign(flags: Record<string, unknown>, version: unknown = 1): unknown {
  return { id: 'campaign-1', minVersion: '1.0.0', rollout: { version, flags } }
}

describe('rollout flags', () => {
  beforeEach(() => {
    resetRolloutConfigForTests()
  })

  it('ships every flip inactive', () => {
    expect(ROLLOUT_FLAG_NAMES.every((name) => BAKED_ROLLOUT_FLAGS[name] === false)).toBe(true)
  })

  it('resolves to the baked value when the block is absent, invalid or a newer version', () => {
    for (const payload of [
      null,
      'nudge',
      [],
      { id: 'campaign-1', minVersion: '1.0.0' },
      { rollout: 'on' },
      { rollout: { version: 1 } },
      campaign({ 'pinned-relay-default': { state: 'on' } }, 2)
    ]) {
      const config = parseRolloutConfig(payload)
      expect(config).toBeNull()
      expect(resolveRolloutFlag('pinned-relay-default', { ...install, config })).toBe(false)
    }
  })

  it('drops only the entries it cannot read, and ignores flags it does not know', () => {
    const config = parseRolloutConfig(
      campaign({
        'pinned-relay-default': { state: 'on', percent: 100, futureField: true },
        'managed-servers-visible': { state: 'sideways' },
        'serve-on-orcad-default': { state: 'on', percent: 140 },
        'legacy-relay-dir-sweep': { state: 'on', minVersion: '2.0.0', maxVersion: '1.0.0' },
        'flag-from-a-newer-build': { state: 'on' }
      })
    )
    expect(config).toEqual({ 'pinned-relay-default': { state: 'on', percent: 100 } })
  })

  it('keeps the kill switch on and lets "default" defer to the build', () => {
    const config: RolloutConfig = {
      'pinned-relay-default': { state: 'off' },
      'managed-servers-visible': { state: 'default' }
    }
    expect(resolveRolloutFlag('pinned-relay-default', { ...install, config })).toBe(false)
    expect(resolveRolloutFlag('managed-servers-visible', { ...install, config })).toBe(false)
    expect(resolveRolloutFlag('serve-on-orcad-default', { ...install, config })).toBe(false)
  })

  it('applies an entry only inside its version range', () => {
    const config: RolloutConfig = {
      'pinned-relay-default': { state: 'on', minVersion: '1.5.0', maxVersion: '1.5.9' }
    }
    expect(resolveRolloutFlag('pinned-relay-default', { ...install, config })).toBe(true)
    for (const appVersion of ['1.4.9', '1.6.0', 'not-a-version']) {
      expect(resolveRolloutFlag('pinned-relay-default', { ...install, appVersion, config })).toBe(
        false
      )
    }
  })

  it('admits about the requested share of installs, stably per install and flag', () => {
    const config: RolloutConfig = { 'pinned-relay-default': { state: 'on', percent: 25 } }
    const ids = Array.from({ length: 4000 }, (_, index) => `install-${index}`)
    const admitted = ids.filter((installId) =>
      resolveRolloutFlag('pinned-relay-default', { ...install, installId, config })
    )
    expect(admitted.length / ids.length).toBeGreaterThan(0.22)
    expect(admitted.length / ids.length).toBeLessThan(0.28)
    expect(rolloutBucket('install-a', 'pinned-relay-default')).toBe(
      rolloutBucket('install-a', 'pinned-relay-default')
    )
    // Why: each flip draws its own cohort, so one 25% step doesn't pick the same users every time.
    const sameForOtherFlag = ids.filter(
      (installId) =>
        rolloutBucket(installId, 'pinned-relay-default') ===
        rolloutBucket(installId, 'managed-servers-visible')
    )
    expect(sameForOtherFlag.length).toBeLessThan(ids.length / 10)
  })

  it('keeps an install it cannot bucket on the baked value, except at 0% or 100%', () => {
    const partial: RolloutConfig = { 'pinned-relay-default': { state: 'on', percent: 50 } }
    const full: RolloutConfig = { 'pinned-relay-default': { state: 'on' } }
    const none: RolloutConfig = { 'pinned-relay-default': { state: 'on', percent: 0 } }
    const noId = { appVersion: '1.5.0', installId: null }
    expect(resolveRolloutFlag('pinned-relay-default', { ...noId, config: partial })).toBe(false)
    expect(resolveRolloutFlag('pinned-relay-default', { ...noId, config: full })).toBe(true)
    expect(resolveRolloutFlag('pinned-relay-default', { ...install, config: none })).toBe(false)
  })

  it('reads the last recorded block until the next one replaces it', () => {
    expect(isRolloutFlagActive('pinned-relay-default', install)).toBe(false)
    recordRolloutConfig(parseRolloutConfig(campaign({ 'pinned-relay-default': { state: 'on' } })))
    expect(isRolloutFlagActive('pinned-relay-default', install)).toBe(true)
    recordRolloutConfig(parseRolloutConfig({ id: 'campaign-2', minVersion: '1.0.0' }))
    expect(isRolloutFlagActive('pinned-relay-default', install)).toBe(false)
  })
})

describe('e2e rollout override', () => {
  const dirs: string[] = []
  afterEach(() => {
    vi.unstubAllEnvs()
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function flagsFile(flags: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'rollout-e2e-'))
    dirs.push(dir)
    const file = join(dir, 'flags.json')
    writeFileSync(file, JSON.stringify(flags))
    return file
  }

  it('reads the flags file only in an unpackaged e2e launch', () => {
    const file = flagsFile({ 'orcad-source-retirement': { state: 'on' } })
    const env = { ORCA_E2E_USER_DATA_DIR: '/e2e', ORCA_E2E_ROLLOUT_FLAGS_FILE: file }
    expect(readE2ERolloutConfigOverride(env, false)).toEqual({
      'orcad-source-retirement': { state: 'on' }
    })
    expect(readE2ERolloutConfigOverride({ ORCA_E2E_ROLLOUT_FLAGS_FILE: file }, false)).toBeNull()
  })

  it('never reads the flags file in a packaged release', () => {
    const file = flagsFile({ 'orcad-source-retirement': { state: 'on' } })
    const env = { ORCA_E2E_USER_DATA_DIR: '/e2e', ORCA_E2E_ROLLOUT_FLAGS_FILE: file }
    expect(readE2ERolloutConfigOverride(env, true)).toBeNull()
    vi.stubEnv('ORCA_E2E_USER_DATA_DIR', env.ORCA_E2E_USER_DATA_DIR)
    vi.stubEnv('ORCA_E2E_ROLLOUT_FLAGS_FILE', file)
    const context = { appVersion: '1.4.218', installId: null }
    installFakeAppEnvironment({ isPackaged: () => true })
    expect(isRolloutFlagActive('orcad-source-retirement', context)).toBe(false)
    installFakeAppEnvironment({ isPackaged: () => false })
    expect(isRolloutFlagActive('orcad-source-retirement', context)).toBe(true)
  })

  it('treats a missing or unreadable file as no override', () => {
    const env = { ORCA_E2E_USER_DATA_DIR: '/e2e' }
    expect(readE2ERolloutConfigOverride(env, false)).toBeNull()
    expect(
      readE2ERolloutConfigOverride(
        { ...env, ORCA_E2E_ROLLOUT_FLAGS_FILE: '/missing/flags.json' },
        false
      )
    ).toBeNull()
  })
})
