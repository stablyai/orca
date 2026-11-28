import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  parseRolloutConfig,
  recordRolloutPayload,
  resetRolloutConfigForTests,
  resolveRolloutFlag,
  rolloutBucket
} from './rollout-flags'

const userData = { dir: '/nonexistent' }
vi.mock('../../persistence/loading-store/user-data-path', () => ({
  getCanonicalUserDataPath: () => userData.dir
}))

const flags = (entry: unknown) =>
  parseRolloutConfig({ rollout: { version: 1, flags: { 'mac-menu-bar-helper': entry } } })

describe('mac-menu-bar-helper rollout', () => {
  it('bakes on only for prerelease builds and lets the kill switch win everywhere', () => {
    const resolve = (config: ReturnType<typeof flags>, appVersion: string) =>
      resolveRolloutFlag('mac-menu-bar-helper', { config, appVersion, installId: 'install' })
    expect(resolve(null, '1.4.290')).toBe(false)
    expect(resolve(null, '1.4.290-rc.3')).toBe(true)
    expect(resolve(flags({ state: 'off' }), '1.4.290-rc.3')).toBe(false)
    expect(resolve(flags({ state: 'on', maxVersion: '1.4.289' }), '1.4.290')).toBe(false)
    expect(resolve(flags({ state: 'on' }), '1.4.290')).toBe(true)
    expect(resolve(flags({ state: 'on', percent: 'all' }), '1.4.290')).toBe(false)
  })

  it('admits a stable percentage by install bucket and never without an install id', () => {
    const config = flags({ state: 'on', percent: 10 })
    const ids = Array.from({ length: 4000 }, (_, i) => `install-${i}`)
    const admitted = ids.filter((installId) =>
      resolveRolloutFlag('mac-menu-bar-helper', { config, appVersion: '1.4.290', installId })
    )
    expect(admitted.length / ids.length).toBeGreaterThan(0.08)
    expect(admitted.length / ids.length).toBeLessThan(0.12)
    expect(admitted.every((id) => rolloutBucket(id, 'mac-menu-bar-helper') < 10)).toBe(true)
    expect(
      resolveRolloutFlag('mac-menu-bar-helper', { config, appVersion: '1.4.290', installId: null })
    ).toBe(false)
  })
})

it('keeps a saved kill switch when the next entry is unreadable, and drops it only when removed', () => {
  const off = flags({ state: 'off' })
  const payload = (entry: unknown) => ({
    rollout: { version: 1, flags: entry === undefined ? {} : { 'mac-menu-bar-helper': entry } }
  })
  expect(parseRolloutConfig(payload({ state: 'off', percent: '0' }), off)).toEqual(off)
  expect(parseRolloutConfig(payload(undefined), off)).toEqual({})
  expect(parseRolloutConfig({ id: 'campaign' }, off)).toBeNull()
})

it('saves the newest of two overlapping payloads, so a kill switch is not lost', async () => {
  userData.dir = mkdtempSync(join(tmpdir(), 'rollout-flags-'))
  resetRolloutConfigForTests()
  const payload = (state: string) => ({
    rollout: { version: 1, flags: { 'mac-menu-bar-helper': { state } } }
  })
  try {
    const throwing = {
      get rollout(): never {
        throw new Error('unreadable payload')
      }
    }
    // A save that throws must not stop the ones after it.
    await recordRolloutPayload(throwing)
    await recordRolloutPayload(payload('off'))
    // The newer 'off' matches the saved text while the older 'on' is still being written.
    await Promise.all([recordRolloutPayload(payload('on')), recordRolloutPayload(payload('off'))])
    expect(JSON.parse(readFileSync(join(userData.dir, 'rollout-flags.json'), 'utf8'))).toEqual({
      'mac-menu-bar-helper': { state: 'off' }
    })
  } finally {
    rmSync(userData.dir, { recursive: true, force: true })
    userData.dir = '/nonexistent'
    resetRolloutConfigForTests()
  }
})

it('narrows only stable builds with a percentage; prerelease keeps the helper', () => {
  const config = flags({ state: 'on', percent: 0 })
  const resolve = (appVersion: string) =>
    resolveRolloutFlag('mac-menu-bar-helper', { config, appVersion, installId: 'install' })
  expect(resolve('1.4.290')).toBe(false)
  expect(resolve('1.4.290-rc.3')).toBe(true)
})
