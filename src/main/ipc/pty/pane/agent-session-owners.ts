import type { AgentSessionOwnerBinding } from '../../../../shared/agent-session-host-authority'
import { ClaimedAgentPtyOwnerRegistry } from '../../../../shared/claimed-agent-pty-owner'
import { isPtyIncarnationId } from '../../../../shared/pty-incarnation'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { PtySpawnResult } from '../../../providers/pty-provider-contract'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { registeredPtyProviders, tryGetProviderForPty } from '../provider/registry'

// Coordinate claims across provider boundaries, including shared namespaces reached through different relays.
export const agentSessionOwners = new ClaimedAgentPtyOwnerRegistry()
let agentSessionOwnerReconciliation: Promise<void> | null = null
// Bound spawn-gating reconciliation; stalled relay listings must reject as unknown ownership.
const OWNER_LISTING_DEADLINE_MS = 5_000

// Spawn-result restores bypass onPtyData; both entry points must seed list/read history. The empty-record guard prevents duplicate seeding.
export function seedTerminalRestoreRecordsFromSpawnResult(
  runtime: OrcaRuntimeService | undefined,
  result: PtySpawnResult
): void {
  const text =
    typeof result.snapshot === 'string' && result.snapshot.length > 0
      ? result.snapshot
      : typeof result.coldRestore?.scrollback === 'string' &&
          result.coldRestore.scrollback.length > 0
        ? result.coldRestore.scrollback
        : typeof result.replay === 'string' && result.replay.length > 0
          ? result.replay
          : undefined
  const lastTitle =
    typeof result.lastTitle === 'string' && result.lastTitle.length > 0
      ? result.lastTitle
      : typeof result.coldRestore?.lastTitle === 'string' && result.coldRestore.lastTitle.length > 0
        ? result.coldRestore.lastTitle
        : undefined
  if (text !== undefined || lastTitle !== undefined) {
    runtime?.seedTerminalRestoreTail?.(result.id, {
      ...(text !== undefined ? { text } : {}),
      ...(lastTitle !== undefined ? { lastTitle } : {})
    })
  }
}

export function assertSpawnReplyWasLive(result: PtySpawnResult): void {
  if (!result.exitedBeforeSpawnReply) {
    return
  }
  // Lower layers may canonicalize IDs; controller-local pending identity cannot prove this exit.
  throw Object.assign(new Error('agent_session_exited_during_start'), {
    agentSessionOperationOutcome: 'unknown' as const
  })
}

export async function reconcileAgentSessionOwnerListings(): Promise<void> {
  if (agentSessionOwnerReconciliation) {
    return await agentSessionOwnerReconciliation
  }
  const reconciliation = (async () => {
    const deadlineMs = Date.now() + OWNER_LISTING_DEADLINE_MS
    const listings = await Promise.all(
      registeredPtyProviders().map(async ({ provider, hostId }) => ({
        hostId,
        sessions: await provider.listProcesses({ deadlineMs }).catch(() => {
          throw new Error('agent_session_ownership_unknown')
        })
      }))
    )
    const advertisedOwners: AgentSessionOwnerBinding[] = []
    const advertisedOwnerSessions: {
      id: string
      hostId: ExecutionHostId
      incarnationId: string
    }[] = []
    for (const { hostId, sessions } of listings) {
      for (const session of sessions) {
        const incarnationId = session.incarnationId
        let hasAdvertisedOwner = false
        for (const owner of session.agentSessionOwners ?? []) {
          if (owner.ptyId !== session.id || !isPtyIncarnationId(incarnationId)) {
            // Without incarnation proof, a recovered claim cannot safely reject delayed exits.
            throw new Error('agent_session_ownership_unknown')
          }
          advertisedOwners.push(owner)
          hasAdvertisedOwner = true
        }
        if (hasAdvertisedOwner && isPtyIncarnationId(incarnationId)) {
          advertisedOwnerSessions.push({ id: session.id, hostId, incarnationId })
        }
      }
    }
    agentSessionOwners.reconcileAuthoritative(advertisedOwners, {
      // Reconnecting relays can still own live PTYs; only claim-listing providers prove absence.
      isInAuthoritativeScope: (owner) => {
        const provider = tryGetProviderForPty(owner.ptyId)
        return provider?.providesAgentSessionOwnerListings?.(owner.ptyId) === true
      }
    })
    for (const session of advertisedOwnerSessions) {
      ptyOwnership.set(session.id, session.hostId)
      ptyIncarnationById.set(session.id, session.incarnationId)
    }
  })()
  agentSessionOwnerReconciliation = reconciliation
  try {
    await reconciliation
  } finally {
    if (agentSessionOwnerReconciliation === reconciliation) {
      agentSessionOwnerReconciliation = null
    }
  }
}
