import { describe, it, expect, vi } from 'vitest'
import type { Store } from '../persistence'
import type { GlobalSettings } from '../../shared/types'
import { generateInstallId, readInstallId, resetInstallId } from './install-id'

// Minimal in-memory store stand-in. The real `Store` pulls in Electron + fs,
// which is overkill for testing the install-id read/write contract. We only
// need the two methods install-id.ts consumes.
function makeFakeStore(initial: Partial<GlobalSettings>): Store {
  let settings = { ...initial } as GlobalSettings
  const store = {
    getSettings: vi.fn(() => settings),
    updateSettings: vi.fn((updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates } as GlobalSettings
      return settings
    })
  }
  return store as unknown as Store
}

describe('install-id', () => {
  describe('generateInstallId', () => {
    it('produces a UUID v4 string', () => {
      const id = generateInstallId()
      // RFC 4122 v4: 8-4-4-4-12 hex with version nibble `4` and variant nibble 8/9/a/b.
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    })

    it('produces a different id on each call', () => {
      expect(generateInstallId()).not.toBe(generateInstallId())
    })
  })

  describe('readInstallId', () => {
    it('returns the persisted install id', () => {
      const store = makeFakeStore({
        telemetry: {
          optedIn: true,
          installId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          existedBeforeTelemetryRelease: false
        }
      })
      expect(readInstallId(store)).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    })

    it('returns undefined when telemetry is not initialized', () => {
      const store = makeFakeStore({})
      expect(readInstallId(store)).toBeUndefined()
    })
  })

  describe('resetInstallId', () => {
    it('generates a new id, persists it, and preserves sibling telemetry fields', () => {
      const store = makeFakeStore({
        telemetry: {
          optedIn: true,
          installId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          existedBeforeTelemetryRelease: false,
          firstRunNoticeShown: true
        }
      })

      const newId = resetInstallId(store)

      expect(newId).not.toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
      expect(newId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

      // Read-back should reflect the new id and keep everything else intact.
      expect(store.getSettings().telemetry).toEqual({
        optedIn: true,
        installId: newId,
        existedBeforeTelemetryRelease: false,
        firstRunNoticeShown: true
      })
    })

    it('initializes telemetry defensively if the block is somehow missing', () => {
      // Should not happen after migration — exercised to prove the Privacy
      // pane button will not throw if the user reaches it before migration
      // has run (startup-ordering bug). We prefer a usable store over a
      // silent crash; a future maintainer should leave this branch in place.
      const store = makeFakeStore({})
      const newId = resetInstallId(store)
      expect(store.getSettings().telemetry).toEqual({
        optedIn: null,
        installId: newId,
        existedBeforeTelemetryRelease: true
      })
    })
  })
})
