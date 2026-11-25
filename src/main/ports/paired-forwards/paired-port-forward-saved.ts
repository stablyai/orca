import type { PortForwardEntry } from '../../../shared/remote-runtime/ssh/ssh-types'
import type { RestoredPortForwardMove } from '../../../shared/remote-runtime/host-catalog/runtime-environment-port-forward-channel'
import {
  readPairedServerSavedPortForwards,
  type PairedServerSavedPortForwards
} from '../../../shared/remote-runtime/host-catalog/paired-server-saved-port-forwards'
import { persistedStore } from '../../ipc/ssh/ssh-ipc-context'
import {
  nextSavedPortForwards,
  type ForwardMapping
} from '../../ssh/port-forwarding/saved-port-forward-list'

// Moves wait here until a window takes them; a person who never looks needs only the latest few.
const MAX_PENDING_MOVES = 32

export type PairedPortForwardStore = {
  all: () => Readonly<Record<string, unknown>>
  set: (environmentId: string, record: PairedServerSavedPortForwards | null) => void
}

let store: PairedPortForwardStore | null = null
let pendingMoves: RestoredPortForwardMove[] = []

export function setPairedPortForwardStore(next: PairedPortForwardStore | null): void {
  store = next
}

export function savedPairedPortForwardEnvironmentIds(): string[] {
  return Object.keys(store?.all() ?? {})
}

export function savedPairedPortForwards(
  environmentId: string
): PairedServerSavedPortForwards | null {
  const raw = store?.all()[environmentId]
  return raw === undefined ? null : readPairedServerSavedPortForwards(raw)
}

/** Every paired server's and SSH host's saved local ports, left for their own forwards even while
 *  that host is offline. */
export function savedForwardLocalPorts(): Set<number> {
  return new Set([
    ...savedPairedPortForwardEnvironmentIds().flatMap(
      (id) => savedPairedPortForwards(id)?.forwards.map((forward) => forward.localPort) ?? []
    ),
    // Every persisted target, including a suspended recipe VM's the SSH list leaves out.
    ...(persistedStore?.getSshTargets() ?? []).flatMap((target) =>
      (target.portForwards ?? []).map((forward) => forward.localPort)
    )
  ])
}

export function forgetSavedPairedPortForwards(environmentId: string): void {
  store?.set(environmentId, null)
}

/** Saves the server's live forwards and keeps saved ones not open now, minus `dropped`. A forward
 *  saved for another host key is replaced, never merged. */
export function savePairedPortForwards(
  environmentId: string,
  hostKey: string | undefined,
  active: readonly PortForwardEntry[],
  dropped: readonly ForwardMapping[] = []
): void {
  const existing = savedPairedPortForwards(environmentId)
  const key = hostKey ?? existing?.hostKeyFingerprint
  if (!store || !key) {
    return
  }
  const kept = existing?.hostKeyFingerprint === key ? existing.forwards : []
  const forwards = nextSavedPortForwards(active, kept, dropped)
  store.set(environmentId, forwards.length > 0 ? { hostKeyFingerprint: key, forwards } : null)
}

export function recordRestoredPortForwardMove(
  environmentId: string,
  saved: ForwardMapping,
  localPort: number
): void {
  const move = {
    environmentId,
    remotePort: saved.remotePort,
    previousLocalPort: saved.localPort,
    localPort
  }
  pendingMoves = [...pendingMoves, move].slice(-MAX_PENDING_MOVES)
}

/** Restored forwards that moved to another port here since the last take; each is returned once. */
export function takeRestoredPairedPortForwardMoves(): RestoredPortForwardMove[] {
  const moves = pendingMoves
  pendingMoves = []
  return moves
}

export function restoredPairedPortForwardMovesPending(): boolean {
  return pendingMoves.length > 0
}
