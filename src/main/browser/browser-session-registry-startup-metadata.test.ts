import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LOCAL_ORCA_PROFILE_ID,
  getOrcaProfileBrowserSessionPartition
} from '../../shared/orca-profiles'
import {
  createFsState,
  installModuleMocks,
  META_PATH,
  seedMeta
} from './__mocks__/browser-session-registry-persistence-fixture'

describe('browser profile startup metadata reads', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it.each([10, 100])(
    'reads one snapshot when restoring %i profiles and keeps extension assignments current',
    async (count) => {
      const fsState = createFsState()
      const profiles = Array.from({ length: count }, (_, index) => {
        const id = `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
        return {
          id,
          scope: 'isolated',
          partition: getOrcaProfileBrowserSessionPartition(DEFAULT_LOCAL_ORCA_PROFILE_ID, id),
          label: `Browser ${index}`,
          source: null
        }
      })
      const enabledExtensionIdsByProfileId = Object.fromEntries([
        ['default', ['default-extension']],
        ...profiles.map((profile, index) => [profile.id, [`extension-${index}`]])
      ])
      seedMeta(fsState, { profiles, enabledExtensionIdsByProfileId })
      installModuleMocks(fsState)
      const attachExtensions = vi.fn()
      vi.doMock('./extensions/browser-extension-session-loader', () => ({
        attachBrowserExtensionsToProfileSession: attachExtensions
      }))
      const { browserSessionRegistry } = await import('./browser-session-registry')
      const { readFileSync } = await import('node:fs')
      vi.mocked(readFileSync).mockClear()

      browserSessionRegistry.initializeBrowserSessionsFromPersistedState()

      expect(
        vi.mocked(readFileSync).mock.calls.filter(([path]) => path === META_PATH)
      ).toHaveLength(1)
      expect(browserSessionRegistry.listProfiles()).toHaveLength(count + 1)
      expect(attachExtensions).toHaveBeenCalledTimes(count + 1)
      for (const profile of browserSessionRegistry.listProfiles()) {
        expect(attachExtensions).toHaveBeenCalledWith(
          profile,
          enabledExtensionIdsByProfileId[profile.id]
        )
      }

      seedMeta(fsState, {
        profiles,
        enabledExtensionIdsByProfileId: { default: ['new-extension'] }
      })
      attachExtensions.mockClear()
      vi.mocked(readFileSync).mockClear()

      browserSessionRegistry.initializeBrowserSessionsFromPersistedState()

      expect(
        vi.mocked(readFileSync).mock.calls.filter(([path]) => path === META_PATH)
      ).toHaveLength(1)
      expect(attachExtensions).toHaveBeenCalledWith(browserSessionRegistry.getDefaultProfile(), [
        'new-extension'
      ])
      for (const profile of profiles) {
        expect(attachExtensions).toHaveBeenCalledWith(profile, [])
      }
    }
  )
})
