import { beforeEach, describe, expect, it, vi } from 'vitest'

const { netFetchMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn()
}))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

import { fetchNudge, versionMatchesRange, shouldApplyNudge } from './updater-nudge'
import { isRolloutFlagActive, resetRolloutConfigForTests } from './updater/rollout-flags'

describe('updater-nudge', () => {
  beforeEach(() => {
    netFetchMock.mockReset()
    resetRolloutConfigForTests()
  })

  describe('fetchNudge', () => {
    it('returns a valid config for a well-formed response', async () => {
      netFetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'campaign-1', minVersion: '1.1.0', maxVersion: '1.1.19' })
      })

      const result = await fetchNudge()
      expect(result).toEqual({ id: 'campaign-1', minVersion: '1.1.0', maxVersion: '1.1.19' })
    })

    it('returns a valid config with only maxVersion', async () => {
      netFetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'campaign-2', maxVersion: '1.1.19' })
      })

      const result = await fetchNudge()
      expect(result).toEqual({ id: 'campaign-2', maxVersion: '1.1.19' })
    })

    it('returns null for an empty response', async () => {
      netFetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({})
      })

      await expect(fetchNudge()).resolves.toBeNull()
    })

    it('returns null for a null response', async () => {
      netFetchMock.mockResolvedValue({
        ok: true,
        json: async () => null
      })

      await expect(fetchNudge()).resolves.toBeNull()
    })

    it('returns null on non-ok HTTP response', async () => {
      netFetchMock.mockResolvedValue({ ok: false })

      await expect(fetchNudge()).resolves.toBeNull()
    })

    it('returns null on network error', async () => {
      netFetchMock.mockRejectedValue(new Error('network down'))

      await expect(fetchNudge()).resolves.toBeNull()
    })

    it('trims whitespace from the campaign id', async () => {
      netFetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ id: '  campaign-1  ', minVersion: '1.0.0' })
      })

      const result = await fetchNudge()
      expect(result?.id).toBe('campaign-1')
    })

    it('returns null when id is missing', async () => {
      netFetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ minVersion: '1.0.0' })
      })

      await expect(fetchNudge()).resolves.toBeNull()
    })

    it('returns null when neither version endpoint is present', async () => {
      netFetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'campaign-1' })
      })

      await expect(fetchNudge()).resolves.toBeNull()
    })

    it('returns null when minVersion is invalid', async () => {
      netFetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'campaign-1', minVersion: 'not-a-version' })
      })

      await expect(fetchNudge()).resolves.toBeNull()
    })

    it('returns null when maxVersion is invalid', async () => {
      netFetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'campaign-1', maxVersion: 'wat' })
      })

      await expect(fetchNudge()).resolves.toBeNull()
    })

    it('returns null when the configured range is inverted', async () => {
      netFetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'campaign-1',
          minVersion: '1.2.0',
          maxVersion: '1.1.0'
        })
      })

      await expect(fetchNudge()).resolves.toBeNull()
    })
  })

  describe('rollout block on the same request', () => {
    const install = { appVersion: '1.5.0', installId: 'install-a' }
    const killSwitch = { version: 1, flags: { 'pinned-relay-default': { state: 'on' } } }

    it('records the block without changing the nudge it rides on', async () => {
      netFetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'campaign-1', minVersion: '1.0.0', rollout: killSwitch })
      })

      await expect(fetchNudge()).resolves.toEqual({ id: 'campaign-1', minVersion: '1.0.0' })
      expect(isRolloutFlagActive('pinned-relay-default', install)).toBe(true)
      expect(netFetchMock).toHaveBeenCalledTimes(1)
    })

    it('reads a block even when there is no nudge campaign', async () => {
      netFetchMock.mockResolvedValue({ ok: true, json: async () => ({ rollout: killSwitch }) })

      await expect(fetchNudge()).resolves.toBeNull()
      expect(isRolloutFlagActive('pinned-relay-default', install)).toBe(true)
    })

    it('keeps the last block when a later request fails', async () => {
      netFetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ rollout: killSwitch }) })
      await fetchNudge()
      netFetchMock.mockResolvedValueOnce({ ok: false })
      await fetchNudge()
      netFetchMock.mockRejectedValueOnce(new Error('network down'))
      await fetchNudge()

      expect(isRolloutFlagActive('pinned-relay-default', install)).toBe(true)
    })
  })

  describe('versionMatchesRange', () => {
    it('bounded range match', () => {
      expect(versionMatchesRange('1.1.5', { minVersion: '1.1.0', maxVersion: '1.1.19' })).toBe(true)
      expect(versionMatchesRange('1.1.0', { minVersion: '1.1.0', maxVersion: '1.1.19' })).toBe(true)
      expect(versionMatchesRange('1.1.19', { minVersion: '1.1.0', maxVersion: '1.1.19' })).toBe(
        true
      )
      expect(versionMatchesRange('1.0.9', { minVersion: '1.1.0', maxVersion: '1.1.19' })).toBe(
        false
      )
      expect(versionMatchesRange('1.2.0', { minVersion: '1.1.0', maxVersion: '1.1.19' })).toBe(
        false
      )
    })

    it('upper-only range match', () => {
      expect(versionMatchesRange('1.1.5', { maxVersion: '1.1.19' })).toBe(true)
      expect(versionMatchesRange('1.2.0', { maxVersion: '1.1.19' })).toBe(false)
    })

    it('lower-only range match', () => {
      expect(versionMatchesRange('1.1.5', { minVersion: '1.1.0' })).toBe(true)
      expect(versionMatchesRange('1.0.0', { minVersion: '1.1.0' })).toBe(false)
    })
  })

  describe('shouldApplyNudge', () => {
    const nudge = { id: 'campaign-1', minVersion: '1.0.0' }

    it('returns true when version matches and not dismissed/pending', () => {
      expect(
        shouldApplyNudge({
          nudge,
          appVersion: '1.5.0',
          pendingUpdateNudgeId: null,
          dismissedUpdateNudgeId: null
        })
      ).toBe(true)
    })

    it('returns false when campaign already dismissed', () => {
      expect(
        shouldApplyNudge({
          nudge,
          appVersion: '1.5.0',
          pendingUpdateNudgeId: null,
          dismissedUpdateNudgeId: 'campaign-1'
        })
      ).toBe(false)
    })

    it('returns false when campaign is already pending', () => {
      expect(
        shouldApplyNudge({
          nudge,
          appVersion: '1.5.0',
          pendingUpdateNudgeId: 'campaign-1',
          dismissedUpdateNudgeId: null
        })
      ).toBe(false)
    })

    it('returns false when version does not match', () => {
      expect(
        shouldApplyNudge({
          nudge,
          appVersion: '0.9.0',
          pendingUpdateNudgeId: null,
          dismissedUpdateNudgeId: null
        })
      ).toBe(false)
    })
  })
})
