import type { RelayDispatcher } from './dispatcher'

type RetainedMarker = { params: Record<string, unknown>; estimatedBytes: number }

type MarkerState = {
  method: string
  // Why: one outstanding marker per (client, key) keeps sustained backpressure bounded.
  inFlight: Set<string>
  // Rejected markers, retained per client so they can be republished when the control lane frees up.
  pending: Map<number, Map<string, RetainedMarker>>
  capacityUnsubscribes: Map<number, () => void>
}

/**
 * Publishes a small "your view is stale, re-read it" notification on the control lane after a
 * producer-lane payload was refused. Shared by every producer whose oversized frame would otherwise
 * desync a client silently; the marker is coalesced per key and retried on capacity, never dropped.
 */
export type RelayClientResyncMarkerPublisher = {
  emit(clientId: number, markerKey: string, params: Record<string, unknown>): void
  forgetClient(clientId: number): void
}

export function createRelayClientResyncMarkerPublisher(
  dispatcher: RelayDispatcher,
  method: string
): RelayClientResyncMarkerPublisher {
  const state: MarkerState = {
    method,
    inFlight: new Set(),
    pending: new Map(),
    capacityUnsubscribes: new Map()
  }
  // In-flight keys need no sweep here: closing a client settles every queued and written frame first.
  dispatcher.onClientDetached((clientId) => {
    // Not every detach retires the id: invalidateClient() detaches the primary without removing it and
    // setWrite() revives it, so dropping the markers here would desync the state the reconnect restores.
    if (dispatcher.isClientAttached(clientId)) {
      return
    }
    forgetClientMarkers(state, clientId)
  })
  return {
    emit(clientId, markerKey, params) {
      const retained = state.pending.get(clientId)?.get(markerKey)
      if (retained) {
        // Latest generation wins: a retained marker that has not been sent yet must not replay a
        // projection the producer has already moved past.
        retained.params = params
        retained.estimatedBytes = dispatcher.notificationFrameBytes(method, params)
        return
      }
      // Per key, never per client alone: an outstanding marker for one subject must not suppress another's resync.
      if (state.inFlight.has(markerId(clientId, markerKey))) {
        return
      }
      publishMarker(dispatcher, state, clientId, markerKey, params)
    },
    forgetClient(clientId) {
      forgetClientMarkers(state, clientId)
    }
  }
}

function markerId(clientId: number, markerKey: string): string {
  return `${clientId} ${markerKey}`
}

function forgetClientMarkers(state: MarkerState, clientId: number): void {
  // Unsubscribe first so no re-entrant flush can observe a half-cleared client.
  state.capacityUnsubscribes.get(clientId)?.()
  state.capacityUnsubscribes.delete(clientId)
  state.pending.delete(clientId)
}

// Why: the control lane — on the producer lane the marker would hit the same full queue that just
// rejected the payload and be dropped, silently desyncing the client.
function publishMarker(
  dispatcher: RelayDispatcher,
  state: MarkerState,
  clientId: number,
  markerKey: string,
  params: Record<string, unknown>,
  estimatedBytes?: number
): void {
  const key = markerId(clientId, markerKey)
  const frameBytes = estimatedBytes ?? dispatcher.notificationFrameBytes(state.method, params)
  state.inFlight.add(key)
  let settled = false
  const accepted = dispatcher.tryNotifyClient(
    clientId,
    state.method,
    params,
    (result) => {
      // Settles on write, drop, or client close, so the slot can never leak.
      settled = true
      state.inFlight.delete(key)
      if (result.ok) {
        return
      }
      // A frame the sink never wrote leaves the client just as desynced as a rejected one — setWrite
      // fails every queued and in-flight frame this way. Retain unconditionally: a real detach clears
      // it through onClientDetached, which fires after this settlement.
      retainMarker(dispatcher, state, clientId, markerKey, params, frameBytes)
    },
    { controlOverflow: 'reject' }
  )
  if (accepted || settled) {
    return
  }
  // Admission rejection has no settlement callback: retain the marker instead of desyncing the client.
  state.inFlight.delete(key)
  retainMarker(dispatcher, state, clientId, markerKey, params, frameBytes)
}

function retainMarker(
  dispatcher: RelayDispatcher,
  state: MarkerState,
  clientId: number,
  markerKey: string,
  params: Record<string, unknown>,
  estimatedBytes: number
): void {
  if (!state.capacityUnsubscribes.has(clientId)) {
    const unsubscribe = dispatcher.onClientCapacity(clientId, () =>
      flushPendingMarkers(dispatcher, state, clientId)
    )
    if (!unsubscribe) {
      // The client went away between admission and arming, so there is nothing left to resync.
      return
    }
    state.capacityUnsubscribes.set(clientId, unsubscribe)
  }
  const retained = state.pending.get(clientId)
  if (retained) {
    retained.set(markerKey, { params, estimatedBytes })
    return
  }
  state.pending.set(clientId, new Map([[markerKey, { params, estimatedBytes }]]))
}

function flushPendingMarkers(
  dispatcher: RelayDispatcher,
  state: MarkerState,
  clientId: number
): void {
  const retained = state.pending.get(clientId)
  if (!retained) {
    return
  }
  for (const [markerKey, marker] of Array.from(retained)) {
    // Capacity fires on every lane; retry only frames the control queue can admit now.
    if (!dispatcher.canAdmitControlFrame(clientId, marker.estimatedBytes)) {
      continue
    }
    // Drop before republishing so a synchronous settlement cannot see the marker as still pending —
    // and skip keys a re-entrant flush already took, which would otherwise send the marker twice.
    if (!retained.delete(markerKey)) {
      continue
    }
    publishMarker(dispatcher, state, clientId, markerKey, marker.params, marker.estimatedBytes)
  }
  // Identity check: a re-entrant flush may have retired this set and armed a fresh one to keep.
  if (retained.size > 0 || state.pending.get(clientId) !== retained) {
    return
  }
  forgetClientMarkers(state, clientId)
}
