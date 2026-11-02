import { useCallback } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { subscribeMirroredKey } from '../storage/mirrored-storage-keys'
import { NATIVE_PAGE_STORAGE_REFRESH_KEYS } from './page-storage-keys'

export function useShellPageStorageRefresh(refresh: () => Promise<unknown>, publish: () => void) {
  useFocusEffect(
    useCallback(() => {
      let focused = true
      const refreshAndPublish = () => {
        void refresh().then(
          () => {
            if (focused) {
              publish()
            }
          },
          (error: unknown) => console.warn('[web-shell] could not refresh page settings', error)
        )
      }
      const stopWatching = NATIVE_PAGE_STORAGE_REFRESH_KEYS.map((key) =>
        subscribeMirroredKey(key, (_value, source) => {
          if (focused && source === 'persisted') {
            publish()
          }
        })
      )
      refreshAndPublish()
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'active') {
          refreshAndPublish()
        }
      })
      return () => {
        focused = false
        for (const stop of stopWatching) {
          stop()
        }
        sub.remove()
      }
    }, [refresh, publish])
  )
}
