import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import {
  loadDefaultSessionView,
  readSessionViewOverridesPreference,
  updateSessionViewOverride,
  type MobileSessionView
} from '../storage/session-view-preferences'
import {
  isOverrideScope,
  mergeOverrides,
  isNewerPublication,
  type ViewOverridesRuntime,
  type ViewOverridesState
} from './mobile-session-view-mode-state'
export type MobileSessionViewModeController = {
  isTabChatView: (tabId: string) => boolean
  toggleTabChatView: (tabId: string) => void
}
/** Lets a phone share one tab's terminal/chat view with the host and its paired clients.
 *  `writeHostViewMode` is null when the host cannot accept the write, which also means its
 *  published view is not adoptable — the two are one capability. */
export type MobileSessionTabViewModeBridge = {
  hostViewSource?: object
  readHostViewPublication?: () => { epoch: string | null; version: number }
  readHostViewMode: (tabId: string) => MobileSessionView | undefined
  writeHostViewMode: ((tabId: string, view: MobileSessionView) => Promise<void>) | null
  onHostViewModeWriteError?: (error: unknown) => void
}
/** Resolves each tab's terminal/chat view: a host-published value when the host shares it,
 *  otherwise a per-device default (reloaded on focus so a Settings change applies without
 *  remounting the route) overlaid by persisted per-tab overrides that pin a session regardless
 *  of what the default later becomes. */
export function useMobileSessionViewMode(args: {
  hostId: string
  worktreeId: string
  sessionTabViewMode?: MobileSessionTabViewModeBridge
}): MobileSessionViewModeController {
  const { hostId, sessionTabViewMode, worktreeId } = args
  const sessionTabViewModeRef = useRef(sessionTabViewMode)
  sessionTabViewModeRef.current = sessionTabViewMode
  const [viewOverridesState, setViewOverridesState] = useState<ViewOverridesState>(() => ({
    hostId,
    worktreeId,
    overrides: new Map(),
    loaded: false
  }))
  const viewOverridesStateRef = useRef(viewOverridesState)
  viewOverridesStateRef.current = viewOverridesState
  const viewOverridesRuntimeRef = useRef<ViewOverridesRuntime | null>(null)
  const pendingHostViewWritesRef = useRef(
    new Map<
      string,
      {
        hostId: string
        worktreeId: string
        source?: object
        viewMode: MobileSessionView
        token: number
        accepted: boolean
        acceptedPublication?: { epoch: string | null; version: number }
      }
    >()
  )
  const nextHostViewWriteTokenRef = useRef(0)
  const [, setPendingVersion] = useState(0)
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
      loadPromise: readSessionViewOverridesPreference(scopeHostId, scopeWorktreeId),
      currentOverrides: new Map(),
      mutationRevisions: new Map()
    }
    viewOverridesRuntimeRef.current = next
    return next
  }, [])
  const [defaultView, setDefaultView] = useState<MobileSessionView>('terminal')
  const defaultViewRef = useRef(defaultView)
  defaultViewRef.current = defaultView
  useEffect(() => {
    const pending = pendingHostViewWritesRef.current
    const bridge = sessionTabViewModeRef.current
    for (const [tabId, write] of pending) {
      if (
        write.hostId !== hostId ||
        write.worktreeId !== worktreeId ||
        write.source !== bridge?.hostViewSource
      ) {
        pending.delete(tabId)
      }
    }
    if (!bridge?.writeHostViewMode) {
      return
    }
    for (const [tabId, write] of pending) {
      if (
        write.hostId === hostId &&
        write.worktreeId === worktreeId &&
        write.source === bridge.hostViewSource &&
        write.accepted &&
        write.acceptedPublication &&
        isNewerPublication(bridge.readHostViewPublication?.(), write.acceptedPublication) &&
        bridge.readHostViewMode(tabId) === write.viewMode
      ) {
        pending.delete(tabId)
      }
    }
  })
  useEffect(() => {
    let active = true
    const runtime = ensureViewOverridesRuntime(hostId, worktreeId)
    void runtime.loadPromise.then((preference) => {
      if (!active) {
        return
      }
      const merged = mergeOverrides(preference.overrides, runtime.currentOverrides)
      runtime.currentOverrides = merged
      const next = { hostId, worktreeId, overrides: merged, loaded: preference.loaded }
      viewOverridesStateRef.current = next
      setViewOverridesState(next)
    })
    return () => {
      active = false
    }
  }, [ensureViewOverridesRuntime, hostId, worktreeId])
  useFocusEffect(
    useCallback(() => {
      let active = true
      void loadDefaultSessionView().then((view) => {
        if (active) {
          setDefaultView(view)
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
      const bridge = sessionTabViewModeRef.current
      if (bridge?.writeHostViewMode) {
        const pending = pendingHostViewWritesRef.current.get(tabId)
        if (
          pending &&
          pending.hostId === hostId &&
          pending.worktreeId === worktreeId &&
          pending.source === bridge.hostViewSource
        ) {
          return pending.viewMode === 'chat'
        }
        const hostViewMode = bridge.readHostViewMode(tabId)
        if (hostViewMode !== undefined) {
          return hostViewMode === 'chat'
        }
      }
      const override = viewOverridesState.overrides.get(tabId)
      return (override ?? (viewOverridesState.loaded ? defaultView : 'terminal')) === 'chat'
    },
    [defaultView, hostId, viewOverridesState, worktreeId]
  )
  const toggleTabChatView = useCallback(
    (tabId: string) => {
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
      const bridge = sessionTabViewModeRef.current
      const pendingWrite = pendingHostViewWritesRef.current.get(tabId)
      const pendingView =
        pendingWrite?.hostId === hostId &&
        pendingWrite.worktreeId === worktreeId &&
        pendingWrite.source === bridge?.hostViewSource
          ? pendingWrite.viewMode
          : undefined
      const hostViewMode = bridge?.writeHostViewMode ? bridge.readHostViewMode(tabId) : undefined
      const fallbackView = currentScope.loaded ? defaultViewRef.current : 'terminal'
      const effectiveView = pendingView ?? hostViewMode
      const currentlyChat =
        effectiveView !== undefined
          ? effectiveView === 'chat'
          : (overrides.get(tabId) ?? fallbackView) === 'chat'
      const nextView = currentlyChat ? 'terminal' : 'chat'
      overrides.set(tabId, nextView)
      const next = { ...currentScope, overrides }
      viewOverridesStateRef.current = next
      setViewOverridesState(next)
      const runtime = ensureViewOverridesRuntime(hostId, worktreeId)
      runtime.currentOverrides = overrides
      const revision = (runtime.mutationRevisions.get(tabId) ?? 0) + 1
      runtime.mutationRevisions.set(tabId, revision)
      const writeHostViewMode = bridge?.writeHostViewMode
      if (writeHostViewMode) {
        const priorOverride = currentScope.overrides.get(tabId)
        const pendingWrites = pendingHostViewWritesRef.current
        const token = nextHostViewWriteTokenRef.current + 1
        nextHostViewWriteTokenRef.current = token
        pendingWrites.set(tabId, {
          hostId,
          worktreeId,
          source: bridge.hostViewSource,
          viewMode: nextView,
          token,
          accepted: false
        })
        void Promise.resolve()
          .then(() => writeHostViewMode(tabId, nextView))
          .then(
            () => {
              const pending = pendingWrites.get(tabId)
              if (
                pending?.token === token &&
                pending.hostId === hostId &&
                pending.worktreeId === worktreeId &&
                pending.source === bridge.hostViewSource
              ) {
                pending.accepted = true
                pending.acceptedPublication = bridge.readHostViewPublication?.()
                if (mountedRef.current) {
                  setPendingVersion((version) => version + 1)
                }
              }
            },
            (error) => {
              const pending = pendingWrites.get(tabId)
              const isCurrentWrite =
                pending?.token === token &&
                pending.hostId === hostId &&
                pending.worktreeId === worktreeId &&
                pending.source === bridge?.hostViewSource &&
                sessionTabViewModeRef.current?.hostViewSource === bridge?.hostViewSource
              if (isCurrentWrite) {
                pendingWrites.delete(tabId)
              }
              if (
                isCurrentWrite &&
                mountedRef.current &&
                viewOverridesRuntimeRef.current === runtime &&
                runtime.mutationRevisions.get(tabId) === revision
              ) {
                const reverted = new Map(runtime.currentOverrides)
                if (priorOverride) {
                  reverted.set(tabId, priorOverride)
                } else {
                  reverted.delete(tabId)
                }
                runtime.currentOverrides = reverted
                const latest = viewOverridesStateRef.current
                if (isOverrideScope(latest, hostId, worktreeId)) {
                  const revertedState = { ...latest, overrides: reverted }
                  viewOverridesStateRef.current = revertedState
                  setViewOverridesState(revertedState)
                }
                sessionTabViewModeRef.current?.onHostViewModeWriteError?.(error)
              }
            }
          )
      }
      void updateSessionViewOverride(hostId, worktreeId, tabId, nextView).catch(async () => {
        if (!mountedRef.current || viewOverridesRuntimeRef.current !== runtime) {
          return
        }
        const preference = await readSessionViewOverridesPreference(hostId, worktreeId)
        if (
          !mountedRef.current ||
          viewOverridesRuntimeRef.current !== runtime ||
          runtime.mutationRevisions.get(tabId) !== revision
        ) {
          return
        }
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
  return { isTabChatView, toggleTabChatView }
}
