import type { AgentSessionOwnerBinding } from '../../../../shared/agent-session-host-authority'
import { ClaimedAgentPtyOwnerRegistry } from '../../../../shared/claimed-agent-pty-owner'
import { isPtyIncarnationId } from '../../../../shared/pty-incarnation'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { IPtyProvider, PtySpawnResult } from '../../../providers/types'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import {
  localProvider,
  sshProviders,
  tryGetProviderForAgentSessionOwner
} from '../provider/registry'

// Why: one main process can route the same remote provider namespace through
// multiple SSH relays; coordinate claims above every provider boundary too.
export const agentSessionOwners = new ClaimedAgentPtyOwnerRegistry()
let agentSessionOwnerReconciliation: Promise<void> | null = null
// Why: this reconcile gates spawn; a wedged relay listing must fail closed (rejecting
// with unknown ownership) instead of blocking the spawn path indefinitely.
const OWNER_LISTING_DEADLINE_MS = 5_000

// Why: restore payloads (reattach snapshot / cold-restore scrollback / relay
// replay + lastTitle) ride spawn RPC results, never onPtyData, so EVERY spawn
// choke point — renderer pty:spawn and the runtime controller — must seed the
// terminal list/read records or headless/CLI-created reattaches stay blank.
// The runtime's empty-record guard makes a second seed for the same session a
// no-op, so overlapping paths cannot double-apply history.
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
  // Why: lower owners can resolve a different canonical id, so controller-local pending ids cannot prove this exit.
  throw Object.assign(new Error('agent_session_exited_during_start'), {
    agentSessionOperationOutcome: 'unknown' as const
  })
}

export async function reconcileAgentSessionOwnerListings(): Promise<void> {
  if (agentSessionOwnerReconciliation) {
    return await agentSessionOwnerReconciliation
  }
  const reconciliation = (async () => {
    const providers: { provider: IPtyProvider; connectionId: string | null }[] = [
      { provider: localProvider, connectionId: null },
      ...Array.from(sshProviders, ([connectionId, provider]) => ({ provider, connectionId }))
    ]
    const deadlineMs = Date.now() + OWNER_LISTING_DEADLINE_MS
    const listings = await Promise.all(
      providers.map(async ({ provider, connectionId }) => ({
        connectionId,
        sessions: await provider.listProcesses({ deadlineMs }).catch(() => {
          throw new Error('agent_session_ownership_unknown')
        })
      }))
    )
    const advertisedOwners: AgentSessionOwnerBinding[] = []
    const advertisedOwnerSessions: {
      id: string
      connectionId: string | null
      incarnationId: string
    }[] = []
    for (const { connectionId, sessions } of listings) {
      for (const session of sessions) {
        const incarnationId = session.incarnationId
        let hasAdvertisedOwner = false
        for (const owner of session.agentSessionOwners ?? []) {
          if (owner.ptyId !== session.id || !isPtyIncarnationId(incarnationId)) {
            // Why: a recovered claim without process-incarnation proof cannot safely reject a delayed exit.
            throw new Error('agent_session_ownership_unknown')
          }
          advertisedOwners.push(owner)
          hasAdvertisedOwner = true
        }
        if (hasAdvertisedOwner && isPtyIncarnationId(incarnationId)) {
          advertisedOwnerSessions.push({ id: session.id, connectionId, incarnationId })
        }
      }
    }
    agentSessionOwners.reconcileAuthoritative(advertisedOwners, {
      // Why: an unregistered relay can still own a live PTY during reconnect;
      // only providers that serialize claims may make listing absence authoritative.
      isInAuthoritativeScope: (owner) => {
        const provider = tryGetProviderForAgentSessionOwner(owner.ptyId)
        return provider?.providesAgentSessionOwnerListings?.(owner.ptyId) === true
      }
    })
    for (const session of advertisedOwnerSessions) {
      ptyOwnership.set(session.id, session.connectionId)
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
