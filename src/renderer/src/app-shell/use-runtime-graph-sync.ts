import { useEffect } from 'react'
import { getSystemPrefersDarkSnapshot } from '../components/terminal-pane/use-system-prefers-dark'
import {
  canSkipRuntimeMobileSessionSyncKeyBuild,
  getRuntimeMobileSessionSyncKey,
  runtimeMobileSessionSyncKeysEqual
} from '../runtime/sync-runtime-graph/sync-key'
import {
  scheduleRuntimeGraphSync,
  setRuntimeGraphStoreStateGetter,
  setRuntimeGraphSyncEnabled
} from '../runtime/sync-runtime-graph'
import { useAppStore } from '../store'

/** Keeps the mobile runtime graph republished as the store's session-visible state changes. */
export function useRuntimeGraphSync(): void {
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)

  useEffect(() => {
    setRuntimeGraphStoreStateGetter(useAppStore.getState)
    return () => {
      setRuntimeGraphStoreStateGetter(null)
    }
  }, [])

  useEffect(() => {
    let previousKey = getRuntimeMobileSessionSyncKey(useAppStore.getState())
    return useAppStore.subscribe((state, previousState) => {
      // Read cached dark-mode state; allocating matchMedia on every store mutation creates garbage.
      const systemPrefersDark = getSystemPrefersDarkSnapshot()
      // Skip key construction when every input reference is unchanged; mirror getRuntimeMobileSessionSyncKey’s fields.
      if (
        canSkipRuntimeMobileSessionSyncKeyBuild(
          state,
          previousState,
          systemPrefersDark,
          previousKey.systemPrefersDark
        )
      ) {
        return
      }
      const nextKey = getRuntimeMobileSessionSyncKey(
        state,
        previousState,
        previousKey,
        systemPrefersDark
      )
      if (runtimeMobileSessionSyncKeysEqual(nextKey, previousKey)) {
        return
      }
      previousKey = nextKey
      scheduleRuntimeGraphSync()
    })
  }, [])

  useEffect(
    () =>
      useAppStore.subscribe((state, previousState) => {
        // Publish project-catalog changes to paired phones.
        if (
          state.repos !== previousState.repos ||
          state.projects !== previousState.projects ||
          state.projectHostSetups !== previousState.projectHostSetups ||
          state.projectOrderBy !== previousState.projectOrderBy ||
          state.personalProjectOrder !== previousState.personalProjectOrder
        ) {
          scheduleRuntimeGraphSync()
        }
      }),
    []
  )

  useEffect(() => {
    setRuntimeGraphSyncEnabled(workspaceSessionReady)
    return () => {
      setRuntimeGraphSyncEnabled(false)
    }
  }, [workspaceSessionReady])
}
