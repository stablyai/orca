import { describe, it, expect, vi } from 'vitest'
import type { Store } from '../persistence'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { generateInstallId, readInstallId } from './install-id'

// Fake only install-id settings reads/writes; real Store imports Electron/filesystem machinery.
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
})
