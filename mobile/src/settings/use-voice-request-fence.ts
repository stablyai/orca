import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { VoiceSettingsOperations } from './voice-settings-operations'

/** Independent concerns on the Voice screens; a write only supersedes outcomes in its own scope. */
export type VoiceRequestScope = 'key' | 'model' | 'config'

/** The desktop a Voice screen talks to: settings operations or the session's RPC client. */
export type VoiceRequestHost = VoiceSettingsOperations | RpcClient

export type VoiceRequestTicket = {
  epoch: number
  scope: VoiceRequestScope | null
  host: VoiceRequestHost | null
}

type ScopeEpochs = Record<VoiceRequestScope, number>

/**
 * Fences async replies on the Voice screens. `begin(scope)` starts a state-writing request; `peek()`
 * tags a read (or, with a scope, a check like a key test) without superseding anything. A newer write
 * hides only the outcomes (errors, spinners, drawers) of older writes in the same scope, so a model
 * select cannot swallow a key-save error. A host swap supersedes every ticket.
 */
export function useVoiceRequestFence(host: VoiceRequestHost | null) {
  const epoch = useRef(0)
  const scopeEpochs = useRef<ScopeEpochs>({ key: 0, model: 0, config: 0 })
  // Why: the newest write whose state snapshot reached the screen; older snapshots must not regress it.
  const appliedSnapshotEpoch = useRef(0)
  const currentHost = useRef(host)

  // Why: layout timing closes the gap where an old-desktop reply could land before a passive effect ran.
  useLayoutEffect(() => {
    if (currentHost.current !== host) {
      currentHost.current = host
      epoch.current += 1
    }
  }, [host])

  const peek = useCallback(
    (scope: VoiceRequestScope | null = null): VoiceRequestTicket => ({
      epoch: epoch.current,
      scope,
      host
    }),
    [host]
  )
  const begin = useCallback(
    (scope: VoiceRequestScope): VoiceRequestTicket => {
      epoch.current += 1
      scopeEpochs.current[scope] = epoch.current
      return { epoch: epoch.current, scope, host }
    },
    [host]
  )
  /** No newer write of any scope and no host swap since the ticket: a read may replace screen state. */
  const isLatest = useCallback(
    (ticket: VoiceRequestTicket) =>
      ticket.epoch === epoch.current && ticket.host === currentHost.current,
    []
  )
  /** No newer write in the ticket's scope on this desktop: its error/success may still be shown. */
  const isLatestInScope = useCallback((ticket: VoiceRequestTicket) => {
    if (ticket.host !== currentHost.current) {
      return false
    }
    if (ticket.scope === null) {
      return ticket.epoch === epoch.current
    }
    return scopeEpochs.current[ticket.scope] <= ticket.epoch
  }, [])
  // Why: a superseded snapshot may hide this write's effect on the desktop, so it re-reads instead.
  const claimSnapshot = useCallback(
    (ticket: VoiceRequestTicket, resync?: () => unknown) => {
      if (ticket.host !== currentHost.current) {
        return false
      }
      if (!isLatestInScope(ticket) || ticket.epoch <= appliedSnapshotEpoch.current) {
        resync?.()
        return false
      }
      appliedSnapshotEpoch.current = ticket.epoch
      return true
    },
    [isLatestInScope]
  )
  /** Still the same desktop: a read's loading spinner is still the user's (errors need isLatest). */
  const isSameHost = useCallback(
    (ticket: VoiceRequestTicket) => ticket.host === currentHost.current,
    []
  )
  // Why: stable identity, since callers list the fence in their useCallback deps.
  return useMemo(
    () => ({ begin, peek, isLatest, isLatestInScope, claimSnapshot, isSameHost }),
    [begin, peek, isLatest, isLatestInScope, claimSnapshot, isSameHost]
  )
}
