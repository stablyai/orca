import type { Store } from '../persistence'
import type { IPtyProvider } from '../providers/types'
import { toAppSshPtyId, toRelaySshPtyId } from '../providers/ssh-pty-id'
import {
  planRelayPtySweep,
  RELAY_PTY_SWEEP_MAX_EVIDENCE_AGE_MS,
  RELAY_PTY_SWEEP_MIN_AGE_MS,
  type RelayPtyOwnershipEvidence
} from '../../shared/ssh-relay-pty-ownership-proof'

export type SshOrphanRelayPtySweepArgs = {
  targetId: string
  store: Store
  provider: IPtyProvider
  /** This client's persisted consumer identity for the target. */
  clientInstanceId: string
  /** True only when the relay granted this connection the negotiated `session-owner` role. */
  isSessionOwner: boolean
  /** Relay PTY ids this connect just reattached, plus any the caller otherwise knows are live. */
  routedPtyIds: Iterable<string>
  shouldContinue: () => boolean
  now?: () => number
  minimumHostAgeMs?: number
  /** Absolute budget for the whole pass, in ms from its start. */
  passBudgetMs?: number
  maximumEvidenceAgeMs?: number
}

/** The two client-side claims the plan needs, read in one pass over the leases.
 *
 *  `routed` is every relay PTY id this client still has a route to: a live lease, an id this
 *  connect reattached, or a stop it recorded and has not delivered.
 *
 *  `expired` is separate on purpose. It is written by four paths, and every one of them
 *  deliberately leaves the remote process running: a pane re-leasing under a new relay id, a pane
 *  surface missing from the layout, a retired reattach, and a reattach the HOST answered "not
 *  found" for. Only the second of those is reached with the process provably alive — the layout
 *  refusal runs after `pty.attach` already succeeded (`restoreReattachedPtyRuntime`), which is
 *  precisely why its own comment reads "topology absence alone is not authority to kill a
 *  process". A reattach that failed on the transport writes nothing at all: it early-returns as
 *  `reattachAttemptsExhausted` and the lease stays `attached`, hence routed.
 *
 *  Folding it into `routed` would work, but it would also lose the reason in the skip log, and this
 *  is the distinction the sweep most needs to be able to explain.
 *
 *  Deliberately the raw state rather than `sshRemotePtyLeaseAllowsReattach`: that predicate answers
 *  "may this lease be reattached", and this asks "may this client stop the process". Every non-
 *  `terminated` state answers no either way, so sorting the marked leases (`supersededBy`,
 *  `relayIdRecycled`) into `routed` instead would move nothing but the skip reason — and both marks
 *  are written by paths that leave the remote process running on purpose, so they must keep
 *  refusing the stop rather than authorizing one. */
function clientClaims(args: SshOrphanRelayPtySweepArgs): {
  routed: Set<string>
  expired: Set<string>
} {
  const routed = new Set<string>(args.routedPtyIds)
  const expired = new Set<string>()
  for (const lease of args.store.getSshRemotePtyLeases(args.targetId)) {
    if (lease.state === 'expired') {
      expired.add(lease.ptyId)
    } else if (lease.state !== 'terminated') {
      routed.add(lease.ptyId)
    }
    if (lease.pendingKill) {
      routed.add(lease.ptyId)
    }
  }
  return { routed, expired }
}

function toEvidence(
  targetId: string,
  process: Awaited<ReturnType<IPtyProvider['listProcesses']>>[number]
): RelayPtyOwnershipEvidence {
  return {
    ptyId: toRelaySshPtyId(targetId, process.id),
    ...(process.incarnationId ? { incarnationId: process.incarnationId } : {}),
    ...(process.ownerClientInstanceId
      ? { ownerClientInstanceId: process.ownerClientInstanceId }
      : {}),
    ...(typeof process.hostAgeMs === 'number' ? { hostAgeMs: process.hostAgeMs } : {}),
    ...(typeof process.paneBound === 'boolean' ? { paneBound: process.paneBound } : {}),
    ...(process.agentSessionOwners ? { agentSessionOwners: process.agentSessionOwners } : {}),
    ...(process.foregroundProcessEvidence
      ? { foregroundProcessEvidence: process.foregroundProcessEvidence }
      : {})
  }
}

/** One budget for the whole pass, because this is opportunistic cleanup bolted onto the most
 *  latency-sensitive and most failure-prone path in the app (#14830, #17830). Without it the
 *  listing and up to eight stops inherit the mux default and connect waits on all of them.
 *  Overrunning it yields an empty pass — the same outcome as finding nothing, never a failed
 *  connect. */
export const RELAY_PTY_SWEEP_PASS_BUDGET_MS = 5_000

/** Stops the relay PTYs this client can prove it created and has since lost every route to.
 *
 *  Runs after reattach, so a PTY this connect reclaimed is already routed and can never be a
 *  candidate. Best-effort and never throws: it is opportunistic cleanup on the connect path, and a
 *  failed connection is a much worse outcome than a slot left leaked for another session.
 *
 *  Costs one `pty.listProcesses` per connect. That is the price of reconciling at all — there is no
 *  cheaper question than asking the authoritative host what it is holding. */
export async function sweepOrphanedRelayPtys(args: SshOrphanRelayPtySweepArgs): Promise<void> {
  if (!args.isSessionOwner || !args.clientInstanceId || !args.shouldContinue()) {
    return
  }
  const now = args.now ?? Date.now
  const deadlineMs = now() + (args.passBudgetMs ?? RELAY_PTY_SWEEP_PASS_BUDGET_MS)
  try {
    const processes = await args.provider.listProcesses({ deadlineMs })
    // The instant the host's observations reached this client. Every later step — reading the
    // leases, planning, issuing the stops — ages them, and the plan has to see that age.
    const listedAtMs = now()
    if (!args.shouldContinue() || now() >= deadlineMs) {
      return
    }
    const claims = clientClaims(args)
    const plan = planRelayPtySweep(
      processes.map((process) => toEvidence(args.targetId, process)),
      {
        clientInstanceId: args.clientInstanceId,
        isSessionOwner: args.isSessionOwner,
        routedPtyIds: claims.routed,
        expiredLeasePtyIds: claims.expired,
        minimumHostAgeMs: args.minimumHostAgeMs ?? RELAY_PTY_SWEEP_MIN_AGE_MS,
        evidenceAgeSinceListingMs: Math.max(0, now() - listedAtMs),
        maximumEvidenceAgeMs: args.maximumEvidenceAgeMs ?? RELAY_PTY_SWEEP_MAX_EVIDENCE_AGE_MS
      }
    )
    if (plan.sweep.length === 0) {
      return
    }
    await Promise.all(
      plan.sweep.map(async (target) => {
        if (!args.shouldContinue()) {
          return
        }
        try {
          // Two fences, both enforced by the host that owns the process. The incarnation stops a
          // relay that renumbered its ids between the read and this call from hitting a stranger;
          // the owner id makes the host re-check the ownership rule itself, so the one irreversible
          // call in this flow is not authorized by the client alone.
          await args.provider.shutdown(toAppSshPtyId(args.targetId, target.ptyId), {
            immediate: true,
            deadlineMs,
            expectedIncarnationId: target.incarnationId,
            expectedOwnerClientInstanceId: args.clientInstanceId
          })
          console.log(
            `[ssh-orphan-sweep] stopped orphaned relay PTY ${args.targetId}/${target.ptyId}`
          )
        } catch (err) {
          // Unverifiable, not failed: the next connect re-reads the inventory and decides again.
          console.warn(
            `[ssh-orphan-sweep] stop for ${args.targetId}/${target.ptyId} is unverifiable: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }
      })
    )
  } catch (err) {
    console.warn(
      `[ssh-orphan-sweep] pass on ${args.targetId} stopped early: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}
