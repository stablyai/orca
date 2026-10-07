import { useCallback, useEffect, useRef, useState } from 'react'
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
  /** Whether a tab's effective view is chat (host value when shared, else per-tab override, else the default). */
  isTabChatView: (tabId: string) => boolean
  toggleTabChatView: (tabId: string) => void
}

/** Lets a phone share one tab's terminal/chat view with the host and its paired clients.
 *  `writeHostViewMode` is null when the host cannot accept the write, which also means its
 *  published view is not adoptable — the two are one capability. */
export type MobileSessionTabViewModeBridge = {
  /** Identity of the connected client; a reconnect must not inherit old optimistic writes. */
  hostViewSource?: object
  readHostViewMode: (tabId: string) => MobileSessionView | undefined
  /** Rejects when the host write fails; the hook clears its pending state and reverts on rejection. */
  writeHostViewMode: ((tabId: string, view: MobileSessionView) => Promise<void>) | null
  /** Surfaces a rejected shared-view write to the user; present only with the write capability. */
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
  // Why: the bridge's identity changes every render and the callbacks below must stay stable,
  // so read the live bridge through a ref rather than a dependency.
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
  // Why: a host write's effect lands only when the host echoes it, so the tapped view must win in
  // the meantime; the token lets an older settle leave a newer pending write alone.
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
  // Why: the toggle callback reads the live default without depending on it, so
  // its identity stays stable and it never captures a stale default.
  const defaultViewRef = useRef(defaultView)
  defaultViewRef.current = defaultView

  // A completed RPC only means the host accepted the write. Keep the optimistic value until a
  // session-tabs snapshot echoes it, otherwise that snapshot can briefly resurrect the old view.
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
      // Why: toggles made during the read are authoritative, but must not
      // discard unrelated persisted overrides from the same worktree.
      const merged = mergeOverrides(preference.overrides, runtime.currentOverrides)
      runtime.currentOverrides = merged
      // Why: an unreadable override store cannot safely be treated as empty when
      // the default is chat; fail closed to terminal until a user toggles.
      const next = { hostId, worktreeId, overrides: merged, loaded: preference.loaded }
      viewOverridesStateRef.current = next
      setViewOverridesState(next)
    })
    return () => {
      active = false
    }
  }, [ensureViewOverridesRuntime, hostId, worktreeId])

  // Why: reload on focus so returning from Settings picks up a changed default.
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
      // Why: a host that shares the view (it accepts our writes) is authoritative whenever it
      // carries a value, so a change made on another client follows here without a local toggle.
      const bridge = sessionTabViewModeRef.current
      if (bridge?.writeHostViewMode) {
        // Why: until the queued write settles the host still echoes the old value, so the tapped
        // view must outrank it or the tap looks dead.
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
      // Until this scope loads, only an immediate user toggle is authoritative;
      // defaulting other tabs to terminal avoids activating stale cross-host chat.
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
      // Flip from the tab's effective view — the host's value when it shares one, else its
      // override, else the default — so a tab following a chat host/default can be pinned back.
      const bridge = sessionTabViewModeRef.current
      // Why: a queued write outranks the host's stale echo here too, or a second tap before the
      // first settles recomputes the same target and is lost.
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
      // Why: only a host that advertised the shared-view capability (a non-null writeHostViewMode)
      // may receive the write; the optimistic local override above already stands regardless.
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
        // Why: Promise.resolve().then keeps a synchronous throw from stranding the pending record.
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
                setPendingVersion((version) => version + 1)
              }
            },
            (error) => {
              const pending = pendingWrites.get(tabId)
              if (
                pending?.token === token &&
                pending.hostId === hostId &&
                pending.worktreeId === worktreeId &&
                pending.source === bridge?.hostViewSource
              ) {
                pendingWrites.delete(tabId)
              }
              // Why: the host never took this mode, so drop the override claiming it — unless a
              // newer toggle for this tab has since replaced it.
              if (
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
              }
              bridge?.onHostViewModeWriteError?.(error)
            }
          )
      }
      // Why: enqueue the individual mutation immediately so a remounted route
      // cannot reorder it or replace unrelated overrides with a stale snapshot.
      void updateSessionViewOverride(hostId, worktreeId, tabId, nextView).catch(async () => {
        if (!mountedRef.current || viewOverridesRuntimeRef.current !== runtime) {
          return
        }
        const preference = await readSessionViewOverridesPreference(hostId, worktreeId)
        // Why: a failed older write must not roll back a newer choice for this tab.
        if (
          !mountedRef.current ||
          viewOverridesRuntimeRef.current !== runtime ||
          runtime.mutationRevisions.get(tabId) !== revision
        ) {
          return
        }
        // Why: if recovery is also unreadable, fail closed instead of treating an
        // unknown store as empty or restoring an earlier optimistic mutation.
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
