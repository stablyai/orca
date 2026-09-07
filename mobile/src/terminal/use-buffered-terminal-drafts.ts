import { useCallback, useRef, useState } from 'react'
import type { RefObject } from 'react'
import {
  type BufferedTerminalDraftRestorationToken,
  type BufferedTerminalDraftValue,
  beginBufferedTerminalDraftRestoration,
  invalidateBufferedTerminalDraftRestoration,
  pruneBufferedTerminalDrafts,
  pruneBufferedTerminalDraftRestorations,
  remapBufferedTerminalDraft,
  remapBufferedTerminalDraftRestoration,
  restoreRejectedBufferedTerminalDraft,
  settleBufferedTerminalDraftRestoration,
  updateBufferedTerminalDraft
} from './buffered-terminal-draft-restoration'

interface BufferedTerminalDraftSend {
  readonly draft: string
  readonly handle: string
  readonly token: BufferedTerminalDraftRestorationToken
}

interface UseBufferedTerminalDraftsOptions {
  readonly activeHandle: string | null
  readonly activeHandleRef: RefObject<string | null>
}

type BufferedTerminalDraftTab = {
  readonly id: string
  readonly type?: string
  readonly leafId?: string
  readonly terminal?: string | null
}

type ReconcileBufferedTerminalDraftTabsOptions = {
  readonly retainMissingSurfaces?: boolean
}

function getBufferedTerminalDraftSurfaceKey(tab: BufferedTerminalDraftTab): string {
  return tab.leafId ? `leaf:${tab.leafId}` : `tab:${tab.id}`
}

export function useBufferedTerminalDrafts({
  activeHandle,
  activeHandleRef
}: UseBufferedTerminalDraftsOptions) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const pendingRestorationsRef = useRef<Map<string, BufferedTerminalDraftRestorationToken>>(
    new Map()
  )
  const handlesBySurfaceRef = useRef<Map<string, string>>(new Map())
  const input = activeHandle ? (drafts[activeHandle] ?? '') : ''

  const setInput = useCallback(
    (value: BufferedTerminalDraftValue) => {
      const handle = activeHandleRef.current
      if (!handle) {
        return
      }
      invalidateBufferedTerminalDraftRestoration(pendingRestorationsRef.current, handle)
      setDrafts((current) => updateBufferedTerminalDraft(current, handle, value))
    },
    [activeHandleRef]
  )

  const beginBufferedTerminalDraftSend = useCallback(
    (handle: string, draft: string): BufferedTerminalDraftSend => {
      const token = beginBufferedTerminalDraftRestoration(pendingRestorationsRef.current, handle)
      setDrafts((current) => updateBufferedTerminalDraft(current, handle, ''))
      return { draft, handle, token }
    },
    []
  )

  const restoreRejectedDraft = useCallback((send: BufferedTerminalDraftSend): void => {
    if (
      !settleBufferedTerminalDraftRestoration(
        pendingRestorationsRef.current,
        send.handle,
        send.token
      )
    ) {
      return
    }
    setDrafts((current) =>
      restoreRejectedBufferedTerminalDraft(current, send.token.handle, send.draft)
    )
  }, [])

  const settleBufferedTerminalDraftSend = useCallback(
    (send: BufferedTerminalDraftSend): boolean =>
      settleBufferedTerminalDraftRestoration(
        pendingRestorationsRef.current,
        send.handle,
        send.token
      ),
    []
  )

  const pruneDrafts = useCallback((retainedHandles: ReadonlySet<string>): void => {
    const retainedMappedHandles = new Set(retainedHandles)
    for (const handle of handlesBySurfaceRef.current.values()) {
      retainedMappedHandles.add(handle)
    }
    setDrafts((current) => pruneBufferedTerminalDrafts(current, retainedMappedHandles))
    pruneBufferedTerminalDraftRestorations(pendingRestorationsRef.current, retainedMappedHandles)
  }, [])

  const reconcileTerminalTabs = useCallback(
    (
      previousTabs: readonly BufferedTerminalDraftTab[],
      nextTabs: readonly BufferedTerminalDraftTab[],
      { retainMissingSurfaces = false }: ReconcileBufferedTerminalDraftTabsOptions = {}
    ): void => {
      const handlesBySurface = handlesBySurfaceRef.current
      for (const tab of previousTabs) {
        if (tab.type && tab.type !== 'terminal') {
          continue
        }
        if (typeof tab.terminal === 'string') {
          const surfaceKey = getBufferedTerminalDraftSurfaceKey(tab)
          if (!handlesBySurface.has(surfaceKey)) {
            handlesBySurface.set(surfaceKey, tab.terminal)
          }
        }
      }

      const retainedHandles = new Set<string>(
        retainMissingSurfaces ? handlesBySurface.values() : []
      )
      const retainedSurfaces = new Set<string>(retainMissingSurfaces ? handlesBySurface.keys() : [])
      const remaps: Array<{ previousHandle: string; nextHandle: string }> = []
      for (const tab of nextTabs) {
        if (tab.type && tab.type !== 'terminal') {
          continue
        }
        const surfaceKey = getBufferedTerminalDraftSurfaceKey(tab)
        retainedSurfaces.add(surfaceKey)
        const previousHandle = handlesBySurface.get(surfaceKey)
        if (typeof tab.terminal === 'string') {
          retainedHandles.add(tab.terminal)
          if (previousHandle && previousHandle !== tab.terminal) {
            remaps.push({ previousHandle, nextHandle: tab.terminal })
          }
          handlesBySurface.set(surfaceKey, tab.terminal)
        } else if (previousHandle) {
          retainedHandles.add(previousHandle)
        }
      }
      for (const surfaceKey of handlesBySurface.keys()) {
        if (!retainedSurfaces.has(surfaceKey)) {
          handlesBySurface.delete(surfaceKey)
        }
      }

      for (const { previousHandle, nextHandle } of remaps) {
        remapBufferedTerminalDraftRestoration(
          pendingRestorationsRef.current,
          previousHandle,
          nextHandle
        )
      }
      pruneBufferedTerminalDraftRestorations(pendingRestorationsRef.current, retainedHandles)
      setDrafts((current) => {
        let next = current
        for (const { previousHandle, nextHandle } of remaps) {
          next = remapBufferedTerminalDraft(next, previousHandle, nextHandle)
        }
        return pruneBufferedTerminalDrafts(next, retainedHandles)
      })
    },
    []
  )

  const resetDrafts = useCallback((): void => {
    pendingRestorationsRef.current.clear()
    handlesBySurfaceRef.current.clear()
    setDrafts((current) => (Object.keys(current).length === 0 ? current : {}))
  }, [])

  const clearPendingRestorations = useCallback((): void => {
    pendingRestorationsRef.current.clear()
  }, [])

  return {
    beginBufferedTerminalDraftSend,
    clearPendingRestorations,
    input,
    pruneDrafts,
    reconcileTerminalTabs,
    resetDrafts,
    restoreRejectedDraft,
    setInput,
    settleBufferedTerminalDraftSend
  }
}
