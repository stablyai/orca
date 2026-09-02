import { useCallback, useEffect, useRef, useState } from 'react'
import {
  readDisabledTerminalLiveInputHandlesPreference,
  saveDisabledTerminalLiveInputHandles
} from '../storage/preferences'
import {
  applyDisabledTerminalLiveInputHandles,
  defaultTerminalLiveInputHandles,
  filterTerminalLiveInputDefaultCandidates,
  pruneTerminalLiveInputHandles
} from '../terminal/terminal-live-input'

type UseTerminalLiveInputModePreferenceOptions = {
  readonly hostId: string
  readonly worktreeId: string
}

export function useTerminalLiveInputModePreference({
  hostId,
  worktreeId
}: UseTerminalLiveInputModePreferenceOptions) {
  const [liveInputTerminalHandles, setLiveInputTerminalHandles] = useState<Set<string>>(
    () => new Set()
  )
  const liveInputTerminalHandlesRef = useRef<Set<string>>(new Set())
  const defaultedLiveInputTerminalHandlesRef = useRef<Set<string>>(new Set())
  const disabledLiveInputTerminalHandlesRef = useRef<Set<string>>(new Set())
  const disabledLiveInputHydratedRef = useRef(false)
  const pendingDisabledLiveInputHydrationEditsRef = useRef<Map<string, boolean>>(new Map())
  const pendingLiveInputDefaultHandlesRef = useRef<Set<string>>(new Set())

  const defaultTerminalHandlesToLiveInput = useCallback((handles: readonly string[]) => {
    // Why: terminal discovery (tab snapshots, list poll, create) can arrive
    // before the async persisted-disabled load on worktree re-entry.
    if (!disabledLiveInputHydratedRef.current) {
      for (const handle of handles) {
        pendingLiveInputDefaultHandlesRef.current.add(handle)
      }
      return
    }
    const defaultableHandles = filterTerminalLiveInputDefaultCandidates(
      handles,
      disabledLiveInputTerminalHandlesRef.current
    )
    const result = defaultTerminalLiveInputHandles(
      liveInputTerminalHandlesRef.current,
      defaultedLiveInputTerminalHandlesRef.current,
      defaultableHandles
    )
    if (!result.changed) {
      return
    }
    const nextEnabledHandles = new Set(result.enabledHandles)
    const nextDefaultedHandles = new Set(result.defaultedHandles)
    liveInputTerminalHandlesRef.current = nextEnabledHandles
    defaultedLiveInputTerminalHandlesRef.current = nextDefaultedHandles
    setLiveInputTerminalHandles(nextEnabledHandles)
  }, [])

  const persistDisabledLiveInputHandles = useCallback(() => {
    void saveDisabledTerminalLiveInputHandles(
      hostId,
      worktreeId,
      disabledLiveInputTerminalHandlesRef.current
    ).catch(() => {})
  }, [hostId, worktreeId])

  const pruneTerminalHandlesFromLiveInput = useCallback(
    (liveHandles: ReadonlySet<string>) => {
      const result = pruneTerminalLiveInputHandles(
        liveInputTerminalHandlesRef.current,
        defaultedLiveInputTerminalHandlesRef.current,
        liveHandles
      )
      let prunedDisabledHandles = false
      for (const handle of disabledLiveInputTerminalHandlesRef.current) {
        if (liveHandles.has(handle)) {
          continue
        }
        disabledLiveInputTerminalHandlesRef.current.delete(handle)
        if (!disabledLiveInputHydratedRef.current) {
          pendingDisabledLiveInputHydrationEditsRef.current.set(handle, false)
        }
        prunedDisabledHandles = true
      }
      if (prunedDisabledHandles && disabledLiveInputHydratedRef.current) {
        persistDisabledLiveInputHandles()
      }
      if (!result.changed) {
        return
      }
      const nextEnabledHandles = new Set(result.enabledHandles)
      const nextDefaultedHandles = new Set(result.defaultedHandles)
      liveInputTerminalHandlesRef.current = nextEnabledHandles
      defaultedLiveInputTerminalHandlesRef.current = nextDefaultedHandles
      setLiveInputTerminalHandles(nextEnabledHandles)
    },
    [persistDisabledLiveInputHandles]
  )

  const clearTerminalLiveInputDefault = useCallback(
    (handle: string) => {
      const liveHandles = new Set([
        ...liveInputTerminalHandlesRef.current,
        ...defaultedLiveInputTerminalHandlesRef.current
      ])
      liveHandles.delete(handle)
      if (!disabledLiveInputHydratedRef.current) {
        pendingDisabledLiveInputHydrationEditsRef.current.set(handle, false)
      }
      if (disabledLiveInputTerminalHandlesRef.current.delete(handle)) {
        if (disabledLiveInputHydratedRef.current) {
          persistDisabledLiveInputHandles()
        }
      }
      pruneTerminalHandlesFromLiveInput(liveHandles)
    },
    [persistDisabledLiveInputHandles, pruneTerminalHandlesFromLiveInput]
  )

  const toggleTerminalLiveInput = useCallback(
    (handle: string): boolean => {
      const nextEnabled = !liveInputTerminalHandlesRef.current.has(handle)
      if (nextEnabled) {
        disabledLiveInputTerminalHandlesRef.current.delete(handle)
      } else {
        disabledLiveInputTerminalHandlesRef.current.add(handle)
      }
      // Why: pre-hydration edits must patch the loaded set per handle; replacing
      // the loaded set would erase other persisted opt-outs for this worktree.
      if (!disabledLiveInputHydratedRef.current) {
        pendingDisabledLiveInputHydrationEditsRef.current.set(handle, !nextEnabled)
      }
      // Why: only persist after hydration; an earlier write would use the
      // reset-empty ref and overwrite other handles' opt-outs for the worktree.
      if (disabledLiveInputHydratedRef.current) {
        persistDisabledLiveInputHandles()
      }
      setLiveInputTerminalHandles((prev) => {
        const next = new Set(prev)
        if (nextEnabled) {
          next.add(handle)
        } else {
          next.delete(handle)
        }
        liveInputTerminalHandlesRef.current = next
        return next
      })
      return nextEnabled
    },
    [persistDisabledLiveInputHandles]
  )

  useEffect(() => {
    liveInputTerminalHandlesRef.current = new Set()
    defaultedLiveInputTerminalHandlesRef.current = new Set()
    disabledLiveInputTerminalHandlesRef.current = new Set()
    disabledLiveInputHydratedRef.current = false
    pendingDisabledLiveInputHydrationEditsRef.current = new Map()
    pendingLiveInputDefaultHandlesRef.current = new Set()
    setLiveInputTerminalHandles(new Set())

    let disposed = false
    // Why: load the persisted opt-outs first so defaulting logic (which can
    // fire immediately from subscriptions) respects prior user choices.
    void readDisabledTerminalLiveInputHandlesPreference(hostId, worktreeId).then((preference) => {
      if (disposed) {
        return
      }
      const pendingEdits = pendingDisabledLiveInputHydrationEditsRef.current
      const hydratedDisabledHandles = new Set(preference.handles)
      for (const [handle, disabled] of pendingEdits) {
        if (disabled) {
          hydratedDisabledHandles.add(handle)
        } else {
          hydratedDisabledHandles.delete(handle)
        }
      }
      disabledLiveInputTerminalHandlesRef.current = hydratedDisabledHandles
      disabledLiveInputHydratedRef.current = true
      pendingDisabledLiveInputHydrationEditsRef.current = new Map()
      if (preference.loaded && pendingEdits.size > 0) {
        persistDisabledLiveInputHandles()
      }
      const result = applyDisabledTerminalLiveInputHandles(
        liveInputTerminalHandlesRef.current,
        defaultedLiveInputTerminalHandlesRef.current,
        hydratedDisabledHandles
      )
      const nextEnabledHandles = new Set(result.enabledHandles)
      const nextDefaultedHandles = new Set(result.defaultedHandles)
      liveInputTerminalHandlesRef.current = nextEnabledHandles
      defaultedLiveInputTerminalHandlesRef.current = nextDefaultedHandles
      setLiveInputTerminalHandles(nextEnabledHandles)
      const pendingDefaultHandles = [...pendingLiveInputDefaultHandlesRef.current]
      pendingLiveInputDefaultHandlesRef.current.clear()
      defaultTerminalHandlesToLiveInput(pendingDefaultHandles)
    })
    return () => {
      disposed = true
    }
  }, [defaultTerminalHandlesToLiveInput, hostId, persistDisabledLiveInputHandles, worktreeId])

  return {
    clearTerminalLiveInputDefault,
    defaultTerminalHandlesToLiveInput,
    liveInputTerminalHandles,
    liveInputTerminalHandlesRef,
    pruneTerminalHandlesFromLiveInput,
    toggleTerminalLiveInput
  }
}
