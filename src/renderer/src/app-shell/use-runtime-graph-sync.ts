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
      // Why: this fires on every store mutation; read the cached prefers-dark snapshot instead of allocating a throwaway MediaQueryList via matchMedia each tick.
      const systemPrefersDark = getSystemPrefersDarkSnapshot()
      // Why: skip the key build when every input is reference-unchanged; the gate mirrors every field getRuntimeMobileSessionSyncKey uses.
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
        // Why: the graph carries the sidebar's Project catalog to paired phones; republish on change.
        if (
          state.repos !== previousState.repos ||
          state.projects !== previousState.projects ||
          state.projectHostSetups !== previousState.projectHostSetups ||
          state.projectOrderBy !== previousState.projectOrderBy
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
