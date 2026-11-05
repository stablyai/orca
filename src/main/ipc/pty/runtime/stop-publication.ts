import { ptyIncarnationById } from '../provider/ownership-state'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import {
  PtyExitProof,
  PtyRetirementWithoutProof,
  type PtyRetirementEvidence
} from '../../../pty/process-retirement/pty-exit-proof'
import {
  closeLegacyRelayPane,
  isLegacyRelayBridgedPty
} from '../../../ssh/legacy-relay/legacy-relay-bridge-registry'

/** Unproved synthetic exit stays unverifiable; rejected incarnation proof publishes nothing for a same-ID respawn. */
export function publishSyntheticExit(
  deps: Pick<PtyRuntimeControllerDeps, 'rememberSyntheticKillExit' | 'sendPtyExitToRenderer'> & {
    runtime?: Pick<OrcaRuntimeService, 'onPtyExit' | 'markPtyLivenessUnverifiable'>
  },
  ptyId: string,
  code: number,
  incarnationId: string | undefined | null,
  evidence: PtyRetirementEvidence
): void | Promise<void> {
  if (incarnationId === null) {
    return
  }
  if (evidence instanceof PtyRetirementWithoutProof) {
    deps.runtime?.markPtyLivenessUnverifiable?.(ptyId, evidence.unverifiableReason)
  }
  const completion = deps.runtime?.onPtyExit(ptyId, code, incarnationId, {
    hostExitConfirmed: evidence instanceof PtyExitProof
  })
  deps.rememberSyntheticKillExit(ptyId, incarnationId)
  deps.sendPtyExitToRenderer({ id: ptyId, code, ...(incarnationId ? { incarnationId } : {}) })
  return completion
}

/**
 * COMPAT(legacy-relay-bridge, revisit 2027-01-15): an older relay's shell stops through the
 * bridge, which retires its lease only on the relay's proof; tombstoning it here would orphan it.
 * Every stop route checks this first, before reading the (absent) SSH provider. A reversible stop
 * is refused: the bridge's recorded stop would outlive it and kill a shell the pane wakes back to.
 */
export function stopLegacyRelayBridgedPty(
  ptyId: string,
  connectionId: string | null,
  reversible = false
): Promise<unknown> | null {
  if (!connectionId || !isLegacyRelayBridgedPty(ptyId)) {
    return null
  }
  return reversible
    ? Promise.reject(new Error('legacy_relay_bridged_pty_cannot_sleep'))
    : closeLegacyRelayPane(ptyId)
}

/** A close keeps the provider incarnation it addressed through every awaited stop/fallback. */
export function capturePtyStopExpectation(
  ptyId: string,
  addressedIncarnationId?: string
): () => boolean {
  const incarnation = ptyIncarnationById.get(ptyId)
  const matchesAddressed =
    !incarnation || !addressedIncarnationId || incarnation === addressedIncarnationId
  const expected = addressedIncarnationId ?? incarnation
  return () =>
    matchesAddressed &&
    (!ptyIncarnationById.has(ptyId) || ptyIncarnationById.get(ptyId) === expected)
}
