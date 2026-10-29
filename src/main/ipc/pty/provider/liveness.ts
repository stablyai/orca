import type { AgentSessionOwnerBinding } from '../../../../shared/agent-session-host-authority'
import { agentSessionOwnerBindingsEqual } from '../../../../shared/claimed-agent-pty-owner'
import { addNodePtyRecoveryHint } from '../../../daemon/node-pty-error-hints'
import type { Store } from '../../../persistence'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import { isCurrentPtyExit, ptyIncarnationById, ptyOwnership } from './ownership-state'
import { getRelayPtyId, tryGetProviderForPty } from './registry'
import {
  KEEP_HISTORY_STOP_POLL_MS,
  KEEP_HISTORY_STOP_SETTLE_MS
} from '../delivery/visibility-state'
import { clearProviderPtyState } from './state-cleanup'
import { PtyExitProof, type PtyRetirementEvidence } from '../../../pty-exit-proof'

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

export async function isProviderPtyLive(
  provider: IPtyProvider,
  ptyId: string,
  deadlineMs?: number
): Promise<boolean> {
  // Share the teardown deadline with the liveness RPC; other callers retain provider defaults.
  return (await provider.listProcesses({ deadlineMs, ptyIds: [ptyId] })).some(
    (session) => session.id === ptyId
  )
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

export async function verifyPtyStopped(
  provider: IPtyProvider,
  ptyId: string,
  opts: { keepHistory?: boolean; deadlineMs?: number } | undefined,
  exitObserved = false
): Promise<boolean> {
  if (await isProviderPtyLive(provider, ptyId, opts?.deadlineMs)) {
    return false
  }
  // Observed exit already proves this incarnation stopped; polling guards only unobserved stops.
  if (!opts?.keepHistory || exitObserved) {
    return true
  }
  const settleDeadline = Date.now() + KEEP_HISTORY_STOP_SETTLE_MS
  // Polling must remain within the caller's absolute teardown deadline.
  const deadline =
    opts.deadlineMs !== undefined ? Math.min(settleDeadline, opts.deadlineMs) : settleDeadline
  while (Date.now() < deadline) {
    await delay(Math.min(KEEP_HISTORY_STOP_POLL_MS, deadline - Date.now()))
    if (Date.now() >= deadline) {
      break
    }
    if (await isProviderPtyLive(provider, ptyId, deadline)) {
      return false
    }
  }
  return true
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
  clearProviderPtyState(id)
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
