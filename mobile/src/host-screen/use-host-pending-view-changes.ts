import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../src/shared/sidebar-inputs-switch'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileViewPatch, WorkspaceViewSettings } from '../worktree/workspace-view-settings'
import { hostViewSettingsWrite } from './host-screen-operations'
import { readHostMethodReply, setCollapsedWrite } from './host-sidebar-feed-operations'
import {
  PENDING_VIEW_CHANGE_STALE_MS,
  addPendingViewChange,
  reconcilePendingViewChanges,
  type PendingViewChange
} from './host-view-pending-changes'

/** How the desktop answered: `waiting` keeps the change (no answer is not a refusal). */
export type PendingViewOutcome = 'settled' | 'refused' | 'unavailable' | 'waiting'

export type PendingViewStatus = {
  pending: readonly PendingViewChange[]
  stale: boolean
}

export type PendingViewControls = {
  sendView: (patch: MobileViewPatch, payload: WorkspaceViewSettings) => Promise<PendingViewOutcome>
  /** `unavailable`: the host has no ui.setCollapsed. */
  sendCollapse: (key: string, collapsed: boolean) => Promise<PendingViewOutcome>
  lastOpId: () => number
  reconcile: (
    ui: WorkspaceViewSettings,
    options: { resend: boolean; sentByOpId: number }
  ) => PendingViewChange[]
}

export type HostPendingViewChanges = { status: PendingViewStatus; controls: PendingViewControls }

type OwnedChanges = { client: RpcClient | null; pending: readonly PendingViewChange[] }

const NO_CHANGES: readonly PendingViewChange[] = []

function useHostPendingViewChanges(client: RpcClient | null): HostPendingViewChanges {
  const [owned, setOwned] = useState<OwnedChanges>({ client, pending: NO_CHANGES })
  const ownedRef = useRef(owned)
  const seqRef = useRef(0)
  const [writer] = useState(
    () => `phone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  )
  // Another host's changes never show or settle here.
  const pending = owned.client === client ? owned.pending : NO_CHANGES
  const [stale, setStale] = useState(false)

  const current = useCallback(
    () => (ownedRef.current.client === client ? ownedRef.current.pending : NO_CHANGES),
    [client]
  )
  const write = useCallback(
    (next: readonly PendingViewChange[]) => {
      ownedRef.current = { client, pending: next }
      setOwned(ownedRef.current)
    },
    [client]
  )

  const send = useCallback(
    async (change: PendingViewChange): Promise<PendingViewOutcome> => {
      if (!client) {
        return 'waiting'
      }
      let outcome: PendingViewOutcome
      try {
        if (change.kind === 'view') {
          const reply = await hostViewSettingsWrite.request(client, change.payload)
          outcome = reply.ok ? 'settled' : 'refused'
        } else {
          const reply = await setCollapsedWrite.request(client, {
            key: change.key,
            collapsed: change.collapsed,
            opId: { writer, seq: change.opId }
          })
          const unavailable =
            readHostMethodReply(reply, setCollapsedWrite.interpret).kind === 'unavailable'
          outcome = unavailable ? 'unavailable' : reply.ok ? 'settled' : 'refused'
        }
      } catch {
        return 'waiting'
      }
      // A change a later one superseded is no longer the user's to hear about.
      if (!current().some((candidate) => candidate.opId === change.opId)) {
        return 'waiting'
      }
      write(current().filter((candidate) => candidate.opId !== change.opId))
      return outcome
    },
    [client, writer, current, write]
  )

  const add = useCallback(
    (change: PendingViewChange) => {
      write(addPendingViewChange(current(), change))
      return send(change)
    },
    [current, write, send]
  )
  const nextOp = (): { opId: number; sentAt: number } => {
    seqRef.current += 1
    return { opId: seqRef.current, sentAt: Date.now() }
  }

  const sendView = useCallback(
    (patch: MobileViewPatch, payload: WorkspaceViewSettings) =>
      add({ ...nextOp(), kind: 'view', patch, payload }),
    [add]
  )
  const sendCollapse = useCallback(
    (key: string, collapsed: boolean) => add({ ...nextOp(), kind: 'collapse', key, collapsed }),
    [add]
  )
  const lastOpId = useCallback(() => seqRef.current, [])
  const reconcile = useCallback(
    (ui: WorkspaceViewSettings, options: { resend: boolean; sentByOpId: number }) => {
      const waiting = reconcilePendingViewChanges(current(), ui, options.sentByOpId)
      if (waiting.length !== current().length) {
        write(waiting)
      }
      if (options.resend) {
        // Each sets a desired value, so sending one again is safe.
        waiting.forEach((change) => void send(change))
      }
      return waiting
    },
    [current, write, send]
  )

  useEffect(() => {
    const oldest = pending[0]
    if (!oldest) {
      setStale(false)
      return
    }
    const wait = oldest.sentAt + PENDING_VIEW_CHANGE_STALE_MS - Date.now()
    setStale(wait <= 0)
    if (wait <= 0) {
      return
    }
    const timer = setTimeout(() => setStale(true), wait)
    return () => clearTimeout(timer)
  }, [pending])

  const controls = useMemo(
    () => ({ sendView, sendCollapse, lastOpId, reconcile }),
    [sendView, sendCollapse, lastOpId, reconcile]
  )
  const status = useMemo(() => ({ pending, stale }), [pending, stale])
  return { status, controls }
}

export const useSwitchedHostPendingViewChanges: (
  client: RpcClient | null
) => HostPendingViewChanges | null = ORCA_SIDEBAR_INPUTS_IS_MAIN
  ? useHostPendingViewChanges
  : () => null
