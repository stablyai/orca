import { beforeEach, describe, expect, it } from 'vitest'
import {
  BAKED_ROLLOUT_FLAGS,
  ROLLOUT_FLAG_NAMES,
  isRolloutFlagActive,
  parseRolloutConfig,
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
