import { settleSessionPreferenceRead } from './session-preference-read'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import {
  loadDefaultSessionView,
  readSessionViewOverridesPreference,
  updateSessionViewOverride,
  type MobileSessionView,
  type SessionViewOverridesPreference
} from '../storage/session-view-preferences'

type ViewOverridesState = {
  hostId: string
  worktreeId: string
  overrides: Map<string, MobileSessionView>
  loaded: boolean
}

type ViewOverridesRuntime = {
  hostId: string
  worktreeId: string
  loadPromise: Promise<SessionViewOverridesPreference>
  currentOverrides: Map<string, MobileSessionView>
  mutationRevisions: Map<string, number>
}

function isOverrideScope(state: ViewOverridesState, hostId: string, worktreeId: string): boolean {
  return state.hostId === hostId && state.worktreeId === worktreeId
}

function mergeOverrides(
  persisted: ReadonlyMap<string, MobileSessionView>,
  current: ReadonlyMap<string, MobileSessionView>
): Map<string, MobileSessionView> {
  const merged = new Map(persisted)
  for (const [tabId, view] of current) {
    merged.set(tabId, view)
  }
  return merged
}

export type MobileSessionViewModeController = {
  ready: boolean
  isTabChatView: (tabId: string) => boolean
  setTabView: (tabId: string, view: MobileSessionView) => void
  toggleTabChatView: (tabId: string) => void
}

// Overlay per-tab overrides on the focus-reloaded device default so Settings changes apply without remounting or changing pinned sessions.
export function useMobileSessionViewMode(args: {
  hostId: string
  worktreeId: string
}): MobileSessionViewModeController {
  const { hostId, worktreeId } = args
  const scope = useMemo(() => ({ hostId, worktreeId }), [hostId, worktreeId])
  const [settledScope, setSettledScope] = useState<typeof scope | null>(null)
  const [defaultViewReady, setDefaultViewReady] = useState(false)
  const [viewOverridesState, setViewOverridesState] = useState<ViewOverridesState>(() => ({
    hostId,
    worktreeId,
    overrides: new Map(),
    loaded: false
  }))
  const viewOverridesStateRef = useRef(viewOverridesState)
  viewOverridesStateRef.current = viewOverridesState
  const viewOverridesRuntimeRef = useRef<ViewOverridesRuntime | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const ensureViewOverridesRuntime = useCallback((scopeHostId: string, scopeWorktreeId: string) => {
    const current = viewOverridesRuntimeRef.current
    if (current?.hostId === scopeHostId && current.worktreeId === scopeWorktreeId) {
      return current
    }
    const next: ViewOverridesRuntime = {
      hostId: scopeHostId,
      worktreeId: scopeWorktreeId,
      loadPromise: settleSessionPreferenceRead(
        readSessionViewOverridesPreference(scopeHostId, scopeWorktreeId)
      ).then((preference) => preference ?? { overrides: new Map(), loaded: false }),
      currentOverrides: new Map(),
      mutationRevisions: new Map()
    }
    viewOverridesRuntimeRef.current = next
    return next
  }, [])
  const [defaultView, setDefaultView] = useState<MobileSessionView>('terminal')
  // Read default via ref so stable toggle callbacks cannot capture stale preferences.
  const defaultViewRef = useRef(defaultView)
  defaultViewRef.current = defaultView

  useEffect(() => {
    let active = true
    const runtime = ensureViewOverridesRuntime(hostId, worktreeId)
    void runtime.loadPromise.then((preference) => {
      if (!active) {
        return
      }
      // User toggles during hydration win without discarding other persisted workspace overrides.
      const merged = mergeOverrides(preference.overrides, runtime.currentOverrides)
      runtime.currentOverrides = merged
      // Unreadable overrides are not empty; fail closed to terminal until an explicit toggle.
      const next = { hostId, worktreeId, overrides: merged, loaded: preference.loaded }
      viewOverridesStateRef.current = next
      setViewOverridesState(next)
      setSettledScope(scope)
    })
    return () => {
      active = false
    }
  }, [ensureViewOverridesRuntime, hostId, worktreeId, scope])

  useFocusEffect(
    useCallback(() => {
      let active = true
      void settleSessionPreferenceRead(loadDefaultSessionView()).then((view) => {
        if (active) {
          if (view) {
            setDefaultView(view)
          }
          setDefaultViewReady(true)
        }
      })
      return () => {
        active = false
      }
    }, [])
  )

  const isTabChatView = useCallback(
    (tabId: string): boolean => {
      if (!isOverrideScope(viewOverridesState, hostId, worktreeId)) {
        return false
      }
      const override = viewOverridesState.overrides.get(tabId)
      // Before scope hydration only explicit user toggles can enable chat; stale cross-host defaults must not.
      return (override ?? (viewOverridesState.loaded ? defaultView : 'terminal')) === 'chat'
    },
    [defaultView, hostId, viewOverridesState, worktreeId]
  )

  const setTabView = useCallback(
    (tabId: string, nextView: MobileSessionView) => {
      const current = viewOverridesStateRef.current
      const currentScope = isOverrideScope(current, hostId, worktreeId)
        ? current
        : {
            hostId,
            worktreeId,
            overrides: new Map<string, MobileSessionView>(),
            loaded: false
          }
      const overrides = new Map(currentScope.overrides)
      overrides.set(tabId, nextView)
      const next = { ...currentScope, overrides }
      viewOverridesStateRef.current = next
      setViewOverridesState(next)

      const runtime = ensureViewOverridesRuntime(hostId, worktreeId)
      runtime.currentOverrides = overrides
      const revision = (runtime.mutationRevisions.get(tabId) ?? 0) + 1
      runtime.mutationRevisions.set(tabId, revision)
      // Enqueue individual writes immediately so remounts cannot reorder them or overwrite unrelated overrides.
      void updateSessionViewOverride(hostId, worktreeId, tabId, nextView).catch(async () => {
        if (!mountedRef.current || viewOverridesRuntimeRef.current !== runtime) {
          return
        }
        const preference = await readSessionViewOverridesPreference(hostId, worktreeId)
        // Older failed persistence cannot roll back a newer pick.
        if (
          !mountedRef.current ||
          viewOverridesRuntimeRef.current !== runtime ||
          runtime.mutationRevisions.get(tabId) !== revision
        ) {
          return
        }
        // Unreadable recovery also fails closed; do not invent empty storage or revive old optimism.
        const reconciled = preference.loaded
          ? mergeOverrides(preference.overrides, runtime.currentOverrides)
          : new Map(runtime.currentOverrides)
        const recoveredOverride = preference.loaded ? preference.overrides.get(tabId) : 'terminal'
        if (recoveredOverride) {
          reconciled.set(tabId, recoveredOverride)
        } else {
          reconciled.delete(tabId)
        }
        runtime.currentOverrides = reconciled
        const latest = viewOverridesStateRef.current
        if (!isOverrideScope(latest, hostId, worktreeId)) {
          return
        }
        const reconciledState = { ...latest, overrides: reconciled, loaded: preference.loaded }
        viewOverridesStateRef.current = reconciledState
        setViewOverridesState(reconciledState)
      })
    },
    [ensureViewOverridesRuntime, hostId, worktreeId]
  )

  const toggleTabChatView = useCallback(
    (tabId: string) => {
      const current = viewOverridesStateRef.current
      const fallbackView = current.loaded ? defaultViewRef.current : 'terminal'
      const currentlyChat =
        isOverrideScope(current, hostId, worktreeId) &&
        (current.overrides.get(tabId) ?? fallbackView) === 'chat'
      setTabView(tabId, currentlyChat ? 'terminal' : 'chat')
    },
    [hostId, setTabView, worktreeId]
  )

  return {
    ready: defaultViewReady && settledScope === scope,
    isTabChatView,
    setTabView,
    toggleTabChatView
  }
}
