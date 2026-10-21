import type { AgentSessionOwnerBinding } from '../../../../shared/agent-session-host-authority'
import { agentSessionOwnerBindingsEqual } from '../../../../shared/claimed-agent-pty-owner'
import { addNodePtyRecoveryHint } from '../../../daemon/node-pty-error-hints'
import type { Store } from '../../../persistence'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import { isCurrentPtyExit, ptyIncarnationById, ptyOwnership } from './ownership-state'
import { getRelayPtyId } from './registry'
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
    // Why: preserve the original stack/name/custom fields while adding the same recovery hint as the pty:spawn path.
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
  // Why: bound the liveness list RPC by the teardown deadline so a wedged daemon
  // fails fast; undefined keeps the provider default for all other callers.
  return (await provider.listProcesses(deadlineMs !== undefined ? { deadlineMs } : undefined)).some(
    (session) => session.id === ptyId
  )
}

export async function isProviderAgentSessionOwnerLive(
  provider: IPtyProvider,
  owner: AgentSessionOwnerBinding
): Promise<boolean> {
  const session = (await provider.listProcesses()).find((candidate) => candidate.id === owner.ptyId)
  if (!session) {
    return false
  }
  if (provider.providesAgentSessionOwnerListings?.(owner.ptyId) !== true) {
    // Why: in-process local owners cannot serialize the controller claim; exact incarnation
    // liveness keeps that claim authoritative until the normal PTY exit releases it.
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
  opts: { keepHistory?: boolean; deadlineMs?: number } | undefined
): Promise<boolean> {
  if (await isProviderPtyLive(provider, ptyId, opts?.deadlineMs)) {
    return false
  }
  if (!opts?.keepHistory) {
    return true
  }
  const settleDeadline = Date.now() + KEEP_HISTORY_STOP_SETTLE_MS
  // Why: deadlineMs is absolute, so the settle poll must not outlive the caller's teardown budget.
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
