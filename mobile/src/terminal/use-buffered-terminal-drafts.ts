import { useStoredBufferedTerminalDrafts } from './use-stored-buffered-terminal-drafts'
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
  readonly owner: string
}

interface UseBufferedTerminalDraftsOptions {
  readonly storageScope?: string
  readonly storageKey?: string
  readonly onStorageError?: () => void
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
  activeHandleRef,
  storageKey,
  storageScope,
  onStorageError
}: UseBufferedTerminalDraftsOptions) {
  const pendingRestorationsRef = useRef<Map<string, BufferedTerminalDraftRestorationToken>>(
    new Map()
  )
  const handlesBySurfaceRef = useRef<Map<string, string>>(new Map())
  const reconciledRef = useRef(false)
  const { drafts, setDrafts, unconfirmed, setUnconfirmed, prepareSend, readDraft, recoveryReady } =
    useStoredBufferedTerminalDrafts(
      storageKey,
      handlesBySurfaceRef,
      reconciledRef,
      onStorageError,
      storageScope
    )
  const owner = `${storageKey ?? ''}:${storageScope ?? 'paired'}`
  const renderedHandleRef = useRef(activeHandle)
  renderedHandleRef.current = activeHandle
  const ownerRef = useRef(owner)
  ownerRef.current = owner
  const pendingSendsRef = useRef(new Map<string, BufferedTerminalDraftRestorationToken>())
  const [pendingSend, setPendingSend] = useState<BufferedTerminalDraftSend | null>(null)
  const unconfirmedRef = useRef(unconfirmed)
  unconfirmedRef.current = unconfirmed
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
      pendingSendsRef.current.set(handle, token)
      const send = { draft, handle, token, owner: ownerRef.current }
      setPendingSend(send)
      unconfirmedRef.current = { ...unconfirmedRef.current, [handle]: draft }
      setUnconfirmed((current) => ({ ...current, [handle]: draft }))
      setDrafts((current) => updateBufferedTerminalDraft(current, handle, ''))
      return send
    },
    [setUnconfirmed]
  )

  const finishSend = useCallback(
    (send: BufferedTerminalDraftSend, retain: boolean) => {
      if (
        send.owner !== ownerRef.current ||
        !settleBufferedTerminalDraftRestoration(pendingSendsRef.current, send.handle, send.token)
      ) {
        return false
      }
      setPendingSend((current) => (current === send ? null : current))
      if (!retain) {
        setUnconfirmed((current) => {
          const next = { ...current }
          delete next[send.token.handle]
          return next
        })
      }
      return true
    },
    [setUnconfirmed]
  )

  const restoreRejectedDraft = useCallback(
    (send: BufferedTerminalDraftSend): void => {
      if (!finishSend(send, false)) {
        return
      }
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
    },
    [finishSend]
  )

  const settleBufferedTerminalDraftSend = useCallback(
    (send: BufferedTerminalDraftSend): boolean =>
      finishSend(send, false) &&
      settleBufferedTerminalDraftRestoration(
        pendingRestorationsRef.current,
        send.handle,
        send.token
      ),
    [finishSend]
  )

  const retainUnconfirmedSend = useCallback(
    (send: BufferedTerminalDraftSend) => {
      finishSend(send, true)
      settleBufferedTerminalDraftRestoration(
        pendingRestorationsRef.current,
        send.handle,
        send.token
      )
    },
    [finishSend]
  )
  const hasUnconfirmedSend = useCallback(
    (handle: string) => Object.hasOwn(unconfirmedRef.current, handle),
    []
  )
  const dismissUnconfirmedSend = useCallback(() => {
    if (
      !activeHandle ||
      renderedHandleRef.current !== activeHandle ||
      ownerRef.current !== owner ||
      pendingSendsRef.current.has(activeHandle) ||
      unconfirmedRef.current[activeHandle] !== unconfirmed[activeHandle]
    ) {
      return
    }
    const nextUnconfirmed = { ...unconfirmedRef.current }
    delete nextUnconfirmed[activeHandle]
    unconfirmedRef.current = nextUnconfirmed
    setUnconfirmed(nextUnconfirmed)
  }, [activeHandle, owner, setUnconfirmed, unconfirmed])
  const editUnconfirmedSend = useCallback(() => {
    if (
      !activeHandle ||
      renderedHandleRef.current !== activeHandle ||
      ownerRef.current !== owner ||
      pendingSendsRef.current.has(activeHandle) ||
      readDraft(activeHandle).length > 0 ||
      !Object.hasOwn(unconfirmed, activeHandle) ||
      unconfirmedRef.current[activeHandle] !== unconfirmed[activeHandle]
    ) {
      return
    }
    setInput(unconfirmed[activeHandle])
    dismissUnconfirmedSend()
  }, [activeHandle, owner, dismissUnconfirmedSend, readDraft, setInput, unconfirmed])

  const pruneDrafts = useCallback(
    (retainedHandles: ReadonlySet<string>): void => {
      const retainedMappedHandles = new Set(retainedHandles)
      for (const handle of handlesBySurfaceRef.current.values()) {
        retainedMappedHandles.add(handle)
      }
      setDrafts((current) => pruneBufferedTerminalDrafts(current, retainedMappedHandles))
      setUnconfirmed((current) => pruneBufferedTerminalDrafts(current, retainedMappedHandles))
      pruneBufferedTerminalDraftRestorations(pendingSendsRef.current, retainedMappedHandles)
      pruneBufferedTerminalDraftRestorations(pendingRestorationsRef.current, retainedMappedHandles)
    },
    [setUnconfirmed]
  )

  const reconcileTerminalTabs = useCallback(
    (
      previousTabs: readonly BufferedTerminalDraftTab[],
      nextTabs: readonly BufferedTerminalDraftTab[],
      { retainMissingSurfaces = false }: ReconcileBufferedTerminalDraftTabsOptions = {}
    ): void => {
      reconciledRef.current = true
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
        remapBufferedTerminalDraftRestoration(pendingSendsRef.current, previousHandle, nextHandle)
        remapBufferedTerminalDraftRestoration(
          pendingRestorationsRef.current,
          previousHandle,
          nextHandle
        )
      }
      pruneBufferedTerminalDraftRestorations(pendingSendsRef.current, retainedHandles)
      pruneBufferedTerminalDraftRestorations(pendingRestorationsRef.current, retainedHandles)
      setUnconfirmed((current) => {
        let next = current
        for (const { previousHandle, nextHandle } of remaps) {
          next = remapBufferedTerminalDraft(next, previousHandle, nextHandle)
        }
        return pruneBufferedTerminalDrafts(next, retainedHandles)
      })
      setDrafts((current) => {
        let next = current
        for (const { previousHandle, nextHandle } of remaps) {
          next = remapBufferedTerminalDraft(next, previousHandle, nextHandle)
        }
        return pruneBufferedTerminalDrafts(next, retainedHandles)
      })
    },
    [setUnconfirmed]
  )

  const resetDrafts = useCallback((): void => {
    pendingRestorationsRef.current.clear()
    pendingSendsRef.current.clear()
    setPendingSend(null)
    handlesBySurfaceRef.current.clear()
    reconciledRef.current = false
    setDrafts((current) => (Object.keys(current).length === 0 ? current : {}))
    setUnconfirmed((current) => (Object.keys(current).length === 0 ? current : {}))
  }, [setUnconfirmed])

  const clearPendingRestorations = useCallback((): void => {
    pendingRestorationsRef.current.clear()
  }, [])

  return {
    unconfirmedCommand:
      activeHandle && Object.hasOwn(unconfirmed, activeHandle) ? unconfirmed[activeHandle] : null,
    awaitingCommandConfirmation:
      pendingSend?.owner === owner && pendingSend.token.handle === activeHandle,
    recoveryReady,
    prepareSend,
    hasUnconfirmedSend,
    retainUnconfirmedSend,
    editUnconfirmedSend,
    dismissUnconfirmedSend,
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
