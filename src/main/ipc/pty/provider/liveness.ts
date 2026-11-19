import type { AgentSessionOwnerBinding } from '../../../../shared/agent-session/lifecycle/operations/agent-session-host-authority'
import { agentSessionOwnerBindingsEqual } from '../../../../shared/agent-session/lifecycle/leases/claimed-agent-pty-owner-snapshot'
import { addNodePtyRecoveryHint } from '../../../daemon/pty-subprocess/node-pty-error-hints'
import type { Store } from '../../../persistence/loading-store/store'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import { isCurrentPtyExit, ptyIncarnationById, ptyOwnership } from './ownership-state'
import { getRelayPtyId, tryGetProviderForPty } from './registry'
import {
  KEEP_HISTORY_STOP_POLL_MS,
  KEEP_HISTORY_STOP_SETTLE_MS
} from '../delivery/visibility-state'
import { clearProviderPtyState } from './state-cleanup'
import {
  PtyExitProof,
  type PtyRetirementEvidence
} from '../../../pty/process-retirement/pty-exit-proof'

export function normalizeNodePtySpawnError(err: unknown): Error {
  const rawMessage = err instanceof Error ? err.message : String(err)
  const hintedMessage = addNodePtyRecoveryHint(rawMessage)
  if (hintedMessage === rawMessage && err instanceof Error) {
    return err
  }
  if (err instanceof Error) {
    // Mutate only the message to retain stack, name and custom error fields.
    err.message = hintedMessage
    return err
  }
  return new Error(hintedMessage)
}

export function isPtyAlreadyGoneError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /Session not found/i.test(message)
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
  })
}

/** Which of these PTYs the provider still lists; one inventory however many ids it checks. */
export async function listLiveProviderPtyIds(
  provider: IPtyProvider,
  ptyIds: readonly string[],
  deadlineMs?: number
): Promise<Set<string>> {
  const wanted = new Set(ptyIds)
  // Share the teardown deadline with the liveness RPC; other callers retain provider defaults.
  const sessions = await provider.listProcesses({ deadlineMs, ptyIds: [...wanted] })
  return new Set(sessions.filter((session) => wanted.has(session.id)).map((session) => session.id))
}

export async function isProviderAgentSessionOwnerLive(
  provider: IPtyProvider,
  owner: AgentSessionOwnerBinding
): Promise<boolean> {
  const session = (await provider.listProcesses({ ptyIds: [owner.ptyId] })).find(
    (candidate) => candidate.id === owner.ptyId
  )
  if (!session) {
    return false
  }
  if (provider.providesAgentSessionOwnerListings?.(owner.ptyId) !== true) {
    // In-process providers cannot list controller claims; exact incarnation liveness preserves their authority.
    const expectedIncarnation = ptyIncarnationById.get(owner.ptyId)
    return expectedIncarnation !== undefined && session.incarnationId === expectedIncarnation
  }
  return Boolean(
    session.agentSessionOwners?.some((candidate) =>
      agentSessionOwnerBindingsEqual(candidate, owner)
    )
  )
}

export type PtyStopAwaitingVerification = { ptyId: string; exitObserved: boolean }

/** Whether each stopped PTY is gone; each round reads one inventory for every PTY it still checks. */
export async function verifyPtysStopped(
  provider: IPtyProvider,
  stops: readonly PtyStopAwaitingVerification[],
  opts: { keepHistory?: boolean; deadlineMs?: number } | undefined
): Promise<Map<string, boolean>> {
  const stopped = new Map<string, boolean>()
  const live = await listLiveProviderPtyIds(
    provider,
    stops.map((stop) => stop.ptyId),
    opts?.deadlineMs
  )
  let unsettled: string[] = []
  for (const { ptyId, exitObserved } of stops) {
    if (live.has(ptyId)) {
      stopped.set(ptyId, false)
    } else if (!opts?.keepHistory || exitObserved) {
      // Observed exit already proves this incarnation stopped; polling guards only unobserved stops.
      stopped.set(ptyId, true)
    } else {
      unsettled.push(ptyId)
    }
  }
  if (unsettled.length === 0) {
    return stopped
  }
  const settleDeadline = Date.now() + KEEP_HISTORY_STOP_SETTLE_MS
  // Polling must remain within the caller's absolute teardown deadline.
  const deadline =
    opts?.deadlineMs !== undefined ? Math.min(settleDeadline, opts.deadlineMs) : settleDeadline
  while (unsettled.length > 0 && Date.now() < deadline) {
    await delay(Math.min(KEEP_HISTORY_STOP_POLL_MS, deadline - Date.now()))
    if (Date.now() >= deadline) {
      break
    }
    const stillLive = await listLiveProviderPtyIds(provider, unsettled, deadline)
    for (const ptyId of stillLive) {
      stopped.set(ptyId, false)
    }
    unsettled = unsettled.filter((ptyId) => !stillLive.has(ptyId))
  }
  for (const ptyId of unsettled) {
    stopped.set(ptyId, true)
  }
  return stopped
}

/** Returns the retired incarnation, or `null` when the proof names a different incarnation than
 *  the record's: a same-id respawn owns it now, so nothing is retired. A proof naming none still
 *  retires: owner reconciliation can stamp the same process's incarnation mid-stop. */
export function finishPtyShutdown(
  id: string,
  connectionId: string | null | undefined,
  store: Store | undefined,
  evidence: PtyRetirementEvidence
): string | undefined | null {
  if (
    evidence instanceof PtyExitProof &&
    evidence.incarnationId !== undefined &&
    !isCurrentPtyExit({ id, incarnationId: evidence.incarnationId })
  ) {
    return null
  }
  const incarnationId = ptyIncarnationById.get(id)
  clearProviderPtyState(id, evidence instanceof PtyExitProof ? { exitProven: true } : {})
  if (connectionId) {
    // Keeps any relay-era undelivered stop on the lease: only host evidence may retire it.
    store?.markSshRemotePtyLease(connectionId, getRelayPtyId(connectionId, id), evidence)
  }
  ptyOwnership.delete(id)
  return incarnationId
}

export async function isRegisteredAgentSessionOwnerLive(
  owner: AgentSessionOwnerBinding
): Promise<boolean> {
  const ownerProvider = tryGetProviderForPty(owner.ptyId)
  if (!ownerProvider) {
    // Why: an owner on a host this process cannot reach is unknown, never absent.
    throw new Error('execution_owner_unavailable')
  }
  return await isProviderAgentSessionOwnerLive(ownerProvider, owner)
}
