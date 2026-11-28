import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  secrets: new Map<string, string>(),
  active: new Set<string>(),
  overviewId: '',
  failPreferenceWrite: false,
  blockAuthorization: true,
  entered: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>()
}))
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) }
}))
vi.mock('../i18n/mobile-i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('../host-catalog/host-store', () => ({ loadHostCatalog: async () => [{ id: 'host-a' }] }))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => state.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      if (key === 'orca:liveActivities' && state.failPreferenceWrite) {
        throw new Error('Preference write failed')
      }
      state.storage.set(key, value)
    },
    removeItem: async (key: string) => {
      state.storage.delete(key)
    }
  }
}))
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => state.secrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    state.secrets.set(key, value)
  },
  deleteItemAsync: async (key: string) => {
    state.secrets.delete(key)
  }
}))
vi.mock('expo-crypto', async () => {
  const { createHash, randomUUID } = await import('node:crypto')
  return {
    randomUUID,
    CryptoDigestAlgorithm: { SHA256: 'sha256' },
    digestStringAsync: async (algorithm: string, input: string) =>
      createHash(algorithm).update(input).digest('hex')
  }
})
vi.mock('./native-live-activities', () => ({
  nativeLiveActivities: {
    authorization: async () => {
      if (state.blockAuthorization) {
        state.blockAuthorization = false
        state.entered.resolve()
        await state.release.promise
      }
      return true
    },
    activities: async () =>
      [...state.active].map((activityId) => ({
        activityId,
        linkId: state.overviewId,
        token: 'aabb',
        state: 'active'
      })),
    end: async (id: string) => {
      state.active.delete(id)
    },
    environment: async () => 'sandbox',
    route: async () => null,
    hasTurn: async () => false,
    storeRoute: async () => {},
    forgetRoute: async () => {},
    start: async (id: string) => {
      state.overviewId = id
      state.active.add('replacement')
      return 'replacement'
    }
  }
}))

import { createLiveActivityCohort } from './live-activity-overview-enrollment'
import {
  retryLiveActivityCleanup,
  setLiveActivityPreferences,
  trackLiveActivity
} from './live-activity-sync'

it('preserves an existing activity when a queued preference save fails during an in-flight track', async () => {
  state.storage.set('orca:liveActivities', JSON.stringify({ enabled: true, showNames: false }))
  const cohort = await createLiveActivityCohort(
    { sources: [{ hostId: 'host-a' }], complete: false },
    'host-a',
    () => true
  )
  state.overviewId = cohort!.overviewId
  state.active.add('existing')
  const tracking = trackLiveActivity('host-a', {
    worktreeId: 'folder:workspace',
    paneKey: 'pane',
    turnKey: 'turn'
  })
  await state.entered.promise
  state.failPreferenceWrite = true
  const failedSave = expect(
    setLiveActivityPreferences({ enabled: false, showNames: false })
  ).rejects.toThrow('Preference write failed')
  state.release.resolve()
  expect(await tracking).toEqual({ tracked: true })
  await failedSave
  await retryLiveActivityCleanup()
  expect([...state.active]).toEqual(['existing'])
  expect(JSON.parse(state.storage.get('orca:liveActivities')!)).toEqual({
    enabled: true,
    showNames: false
  })
})
