/**
 * Collaborative Session Tracker (P2-1)
 *
 * In-memory tracker for CollaborativeSession groupings (see
 * src/shared/agent-collaborative-session.ts for the type/field-level design
 * notes). Structurally mirrors AgentRegistry (src/main/runtime/agent-registry.ts):
 * a hand-written class over a plain Map<sessionId, CollaborativeSession>,
 * global-singleton getter/setter for production use with test injection,
 * clear()/shutdown() for test teardown.
 *
 * ============================================================================
 * Design decision: no persistence
 * ============================================================================
 * Sessions are in-memory only, lost on restart — same choice P0-1's registry
 * made, for the same underlying reason: Orca is a single-user desktop app,
 * and "reboot and re-register/re-form" is the established philosophy here
 * (see AGENT_REGISTRY_LIFECYCLE_INTEGRATION.md's "No persistence: Registry
 * is in-memory only, lost on restart (ok for P0-1)").
 *
 * A CollaborativeSession's participants are keyIds (LiveAgentInfo.keyId),
 * and a keyId is *already* scoped to one process lifetime — it is "derived
 * from SHA256(coordinationKey)" and documented as unique per agent session,
 * churning on every restart (src/shared/agent-consent.ts's doc comment
 * spells this out for why P1-1 keys consent by agentType instead). A
 * CollaborativeSession's participant list is built entirely out of these
 * short-lived keyIds, so persisting the session across a restart would
 * persist a grouping of keyIds that are *already guaranteed* to be stale
 * the moment the app comes back up — every participant would have a new
 * keyId post-restart, making the persisted session refer to agents that can
 * never exist again. There is no "this specific session survived a reboot"
 * scenario that's even coherent given how keyId is defined upstream: unlike
 * P1-1's consent decisions (which are keyed by the restart-stable agentType
 * specifically *so* they can persist), a session has no restart-stable
 * identity to persist against. Persisting it would just be write-and-never-
 * meaningfully-read-again disk I/O. This is a stronger version of the
 * argument P0-1 already made for its own entries, not a new one.
 *
 * ============================================================================
 * Design decision: no TTL / automatic expiration
 * ============================================================================
 * AgentRegistry entries expire on a 60s TTL because a registry entry is a
 * *liveness claim* ("this agent process is still running") backed by a
 * heartbeat loop — without eviction, a crashed agent's stale entry would
 * look identical to a live one forever. A CollaborativeSession makes no
 * such liveness claim about itself. It is descriptive grouping metadata
 * ("these keyIds were, at some point, decided to be part of the same
 * conversation") that stays true regardless of whether the participants
 * are still online right now — a participant's registry entry can expire
 * and come back (new heartbeat) without that meaning the *session* ever
 * stopped being valid. Tying session validity to registry liveness would
 * make sessions flicker in and out of existence on the registry's 60s
 * cadence, which is a confusing contract for something meant to represent
 * an ongoing conversation. Nothing in this phase reads participants' live
 * registry status when deciding whether a session itself is valid — that
 * question was deliberately not asked here; a future consumer that *does*
 * care whether a specific participant is still reachable already has
 * AgentRegistry.get(keyId) for that, independent of this module.
 *
 * A CollaborativeSession does still track lastActivityAt (via touch() /
 * addParticipant()) as descriptive metadata for a future "sort by recency"
 * UI, but nothing evicts a session based on it in this phase — unbounded
 * unused sessions are a memory-bound concern (same as any other in-memory
 * Map in this codebase, e.g. AgentMessageBroker's subscriber map, which
 * also has no TTL), not a correctness one, and this app restarts often
 * enough in practice that unbounded growth was judged not worth a cleanup
 * timer's complexity in this phase. Revisit if usage data ever shows
 * otherwise.
 *
 * ============================================================================
 * Design decision: decoupled from AgentRegistry
 * ============================================================================
 * Unlike AgentMessageBroker.send() (which calls getGlobalAgentRegistry()
 * directly to confirm a target keyId is live before routing to it), this
 * tracker never calls into the registry. create()/addParticipant() accept
 * any string as a participant keyId without checking it against
 * getGlobalAgentRegistry().get(). Two reasons:
 *
 * 1. The registry-liveness argument above: a session tracking a keyId whose
 *    registry entry has since expired is not an error state, so validating
 *    "is this keyId currently live?" at session-mutation time would reject
 *    or complicate perfectly normal cases (e.g. forming a session shortly
 *    before a participant's heartbeat happens to lapse).
 * 2. It keeps this module independently unit-testable with no registry
 *    setup at all — the same reasoning src/shared/agent-consent-gate.ts's
 *    doc comment gives for staying decoupled from the store it sits next
 *    to ("unit-testable with nothing but plain data, no mocks, no I/O").
 *
 * A future phase that wants "reject session creation for a keyId nobody
 * has ever heard of" is a deliberate, separate policy choice layered on
 * top (e.g. at the RPC handler), not baked into the tracker itself.
 *
 * ============================================================================
 * Design decision: AgentMessageBroker.send() does NOT touch sessions
 * ============================================================================
 * Considered and deliberately rejected for this phase:
 *
 * - "Auto-create a session on first successful delivery between two
 *   keyIds": rejected because most send() calls are *not* representative of
 *   a deliberate collaboration — deny-by-default (P1-1) means the large
 *   majority of early sends between a freshly-granted pair, or any
 *   exploratory/probing send, would either be denied outright or would be
 *   a single one-off delivery with no follow-up. Auto-creating session
 *   state as a side effect of message plumbing would silently populate the
 *   session list with noise the user never asked to track, for a feature
 *   ("cross-session conversations") whose actual real-world usage pattern
 *   doesn't exist yet to design against (per this phase's background: no
 *   real trigger calls agent.message.send today — native-chat's @ mention
 *   is file-only). Designing an auto-create heuristic now would be
 *   guessing at a cadence nothing yet exercises.
 * - "Touch an *existing* session's lastActivityAt on delivery, but never
 *   auto-create": considered as a smaller, purely-additive option (it only
 *   ever updates state a caller explicitly created, never invents new
 *   state). Still rejected for this phase: it would make every send() do
 *   an O(sessions) scan for a session containing both keyIds, on the hot
 *   delivery path, in service of a lastActivityAt field nothing yet
 *   displays or reads — speculative coupling for a benefit with no current
 *   consumer. Revisit once a session-aware UI or lifecycle consumer
 *   actually exists to justify keeping it fresh via the message path
 *   specifically (rather than via an explicit touch() call from whatever
 *   orchestration logic drives the conversation).
 *
 * Net effect: src/main/runtime/agent-message-broker.ts is untouched by this
 * phase. Sessions are tracked only when a caller explicitly creates one via
 * the agent.collabSession.* RPC methods (src/main/runtime/rpc/methods/
 * agent-collaborative-session.ts) or calls this tracker's methods directly;
 * they are never implicitly derived from message traffic.
 *
 * ============================================================================
 * Verdict: P1-1 consent stays agentType-scoped, NOT worktree-scoped (this phase)
 * ============================================================================
 * This phase's task explicitly raised the question of whether P1-1's
 * (src/shared/agent-consent.ts, src/shared/agent-consent-gate.ts,
 * src/main/runtime/agent-consent-store.ts) consent decisions — currently
 * keyed only by (sourceAgentType, targetAgentType), globally, with no notion
 * of *which worktree* the conversation is happening in — should become
 * worktree-scoped instead, given that Orca runs many worktrees at once and a
 * "Codex may message Pi" grant made while working in one project silently
 * also covers a completely unrelated worktree the user never reasoned about
 * when they approved it. That is a real question, not a strawman, and it was
 * investigated, not dropped. Verdict for this phase: leave P1-1 exactly as
 * it is (verified: `git diff` against all three P1-1 files is empty — zero
 * lines changed). Reasoning:
 *
 * 1. There is no worktree signal to scope by *anywhere* in this stack today.
 *    A consent check only ever has a keyId to work from (AgentMessageBroker
 *    .send() resolves sourceAgentType/targetAgentType by looking up the
 *    source/target keyId in the P0-1 registry — see agent-message-broker.ts).
 *    The only place a worktree identity could ride along is
 *    LiveAgentInfo.metadata (src/shared/agent-registry.ts) — an untyped,
 *    optional `Record<string, unknown>` bag, not a first-class, validated
 *    field. Worse: nothing populates it in practice. Grepping this entire
 *    repository (src/main, src/renderer, src/cli) for the literal RPC
 *    method name 'agent.registry.register' turns up only: the RPC method's
 *    own definition (src/main/runtime/rpc/methods/agent-registry.ts), its
 *    tests, and one illustrative (never-executed) code snippet inside
 *    AGENT_REGISTRY_LIFECYCLE_INTEGRATION.md showing how a future caller
 *    *would* invoke it. There is no production call site — none of
 *    orca-runtime.ts, the terminal lifecycle, or any agent-session code path
 *    ever calls register(). That integration doc, written for P0-1, still
 *    describes registration as manual, not-yet-wired future integration
 *    work — that work has not landed since.
 *    Scoping consent by worktree would mean keying a security decision on a
 *    field that is, today, always undefined at every real call site. There
 *    is nothing to scope *against* yet.
 * 2. This mirrors a precedent already set one file over: agent-consent-store.ts's
 *    own header explains at length why the P1-1 store deliberately does NOT
 *    live inside persistence.ts's Store (the ~7800-line, worktree-aware,
 *    schema-versioned settings file) — "agent-to-agent messaging consent has
 *    no relationship to any of that state". Reaching into Worktree identity
 *    (src/shared/types.ts's `Worktree` type — itself a heavyweight,
 *    persistence-backed concept with `id`, `repoId`, `projectId`, host
 *    ownership, lineage, etc.) to scope consent would reintroduce exactly
 *    the coupling that file was written to avoid, in service of a field
 *    (metadata.worktreeId) nothing currently sets.
 * 3. Consent's current (sourceAgentType, targetAgentType) granularity is
 *    itself a deliberate, reasoned choice (see agent-consent.ts's header):
 *    it is "exactly the granularity a user reasons about" precisely because
 *    it is coarse and restart-stable. Bolting a worktreeId axis onto that
 *    two-key space, ahead of any UI that could show the user what they're
 *    actually granting, would produce a scoping dimension nobody can see or
 *    reason about — P1-1's only consent-writing RPC surface today is
 *    agent.consent.record (src/main/runtime/rpc/methods/agent-consent.ts),
 *    whose own header says reading/rendering consent state is P1-2's future
 *    job and explicitly out of scope so far. This is the same "don't design
 *    against a UX that doesn't exist yet" problem this file's own "does NOT
 *    touch sessions" section above already declined to guess at for the
 *    broker-integration question.
 * 4. Implementing worktree-scoping anyway, now, would not be a safe minimal
 *    change — it would add new on-disk schema (a migration for existing
 *    orca-agent-consent.json records keyed the old, unscoped way) and a new
 *    per-send registry lookup, none of which any real caller would ever
 *    exercise end-to-end (per point 1). That is strictly worse than today's
 *    state: code that *looks* like an enforced security boundary but is
 *    never actually reached by a live registration path is more dangerous
 *    than honestly having no worktree scoping at all, because it invites
 *    trusting a guarantee nothing currently provides.
 *
 * What would flip this verdict: once (a) some real caller actually wires
 * agent.registry.register with a populated, trustworthy worktree identity —
 * the outstanding P0-1 integration work AGENT_REGISTRY_LIFECYCLE_INTEGRATION.md
 * already flags — and (b) P1-2 grows an actual consent UI that can present
 * "this grant applies within this worktree only" as a choice the user can
 * see and make, worktree-scoped consent becomes a well-motivated, testable
 * follow-up phase. Neither precondition holds yet, so P1-1 is untouched by
 * this phase, deliberately, not by omission.
 */

import { randomUUID } from 'node:crypto'
import type {
  CollaborativeSession,
  CollaborativeSessionCreateRequest,
  CollaborativeSessionListOptions,
  CollaborativeSessionListResult
} from '../../shared/agent-collaborative-session'
import { COLLABORATIVE_SESSION_CONFIG } from '../../shared/agent-collaborative-session'

/**
 * Deduplicate a list of keyIds, preserving first-occurrence order.
 */
function dedupeKeyIds(keyIds: string[]): string[] {
  return [...new Set(keyIds)]
}

/**
 * In-memory tracker of collaborative sessions.
 * Thread-safety: assumes single-threaded Node.js event loop usage, same as
 * AgentRegistry/AgentMessageBroker/AgentConsentStore.
 */
export class CollaborativeSessionTracker {
  /**
   * Map of sessionId -> session.
   */
  private readonly sessions = new Map<string, CollaborativeSession>()

  /**
   * Create a new collaborative session with the given initial participants.
   *
   * Throws (rather than returning a typed error status) for the two
   * caller-error conditions below, mirroring AgentMessageBroker.subscribe()
   * throwing 'agent_message_broker_listener_capacity' for the equivalent
   * "caller asked for something structurally invalid" case rather than
   * returning it through the pub/sub result type. This differs from
   * AgentMessageBroker.send(), which returns a typed status for
   * *routing outcomes* it expects to happen routinely in normal operation
   * (target not found, not subscribed, permission denied) — an empty or
   * oversized participant list is not a routine outcome of normal
   * operation, it is a malformed request, same category as a capacity
   * overflow.
   *
   * @throws {Error} 'collaborative_session_too_few_participants' if fewer
   *   than COLLABORATIVE_SESSION_CONFIG.MIN_PARTICIPANTS keyIds remain after
   *   deduplication.
   * @throws {Error} 'collaborative_session_too_many_participants' if more
   *   than COLLABORATIVE_SESSION_CONFIG.MAX_PARTICIPANTS_PER_SESSION keyIds
   *   remain after deduplication.
   */
  create(request: CollaborativeSessionCreateRequest): CollaborativeSession {
    const participantKeyIds = dedupeKeyIds(request.participantKeyIds)

    if (participantKeyIds.length < COLLABORATIVE_SESSION_CONFIG.MIN_PARTICIPANTS) {
      throw new Error('collaborative_session_too_few_participants')
    }
    if (participantKeyIds.length > COLLABORATIVE_SESSION_CONFIG.MAX_PARTICIPANTS_PER_SESSION) {
      throw new Error('collaborative_session_too_many_participants')
    }

    const now = Date.now()
    const session: CollaborativeSession = {
      sessionId: randomUUID(),
      participantKeyIds,
      createdAt: now,
      lastActivityAt: now,
      metadata: request.metadata
    }

    this.sessions.set(session.sessionId, session)
    return session
  }

  /**
   * Get a single session by sessionId. Returns null if not found.
   */
  get(sessionId: string): CollaborativeSession | null {
    return this.sessions.get(sessionId) ?? null
  }

  /**
   * List all sessions matching optional filters.
   */
  list(options?: CollaborativeSessionListOptions): CollaborativeSessionListResult {
    const allSessions = [...this.sessions.values()]
    let filtered = allSessions

    if (options?.participantKeyId) {
      const wanted = options.participantKeyId
      filtered = filtered.filter((session) => session.participantKeyIds.includes(wanted))
    }

    return {
      sessions: filtered,
      totalCount: allSessions.length
    }
  }

  /**
   * Add a participant to an existing session. Idempotent: adding a keyId
   * that is already a participant is a no-op except for the lastActivityAt
   * bump. Returns the updated session, or null if sessionId is not found.
   *
   * @throws {Error} 'collaborative_session_too_many_participants' if adding
   *   a genuinely new keyId would exceed MAX_PARTICIPANTS_PER_SESSION.
   */
  addParticipant(sessionId: string, keyId: string): CollaborativeSession | null {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return null
    }

    if (!session.participantKeyIds.includes(keyId)) {
      if (
        session.participantKeyIds.length >=
        COLLABORATIVE_SESSION_CONFIG.MAX_PARTICIPANTS_PER_SESSION
      ) {
        throw new Error('collaborative_session_too_many_participants')
      }
      session.participantKeyIds = [...session.participantKeyIds, keyId]
    }

    session.lastActivityAt = Date.now()
    return session
  }

  /**
   * Bump a session's lastActivityAt to now, without changing participants.
   * Returns the updated session, or null if sessionId is not found.
   */
  touch(sessionId: string): CollaborativeSession | null {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return null
    }
    session.lastActivityAt = Date.now()
    return session
  }

  /**
   * Find the most-recently-active session that contains both given keyIds
   * as participants, or null if none exists. Available for a future
   * integration point (e.g. an orchestration layer that wants to reuse an
   * existing conversation between two specific agents rather than creating
   * a duplicate one) — not called from anywhere in this phase; see the
   * class-level doc comment's "AgentMessageBroker.send() does NOT touch
   * sessions" section for why the obvious caller (the broker) deliberately
   * does not use this yet.
   */
  findByParticipants(keyIdA: string, keyIdB: string): CollaborativeSession | null {
    let best: CollaborativeSession | null = null
    for (const session of this.sessions.values()) {
      if (
        session.participantKeyIds.includes(keyIdA) &&
        session.participantKeyIds.includes(keyIdB)
      ) {
        if (!best || session.lastActivityAt > best.lastActivityAt) {
          best = session
        }
      }
    }
    return best
  }

  /**
   * Clear all sessions. Useful for testing or clean shutdown.
   */
  clear(): void {
    this.sessions.clear()
  }
}

/**
 * Global singleton instance of the collaborative session tracker.
 */
let globalCollaborativeSessionTracker: CollaborativeSessionTracker | null = null

/**
 * Get or create the global collaborative session tracker instance.
 */
export function getGlobalCollaborativeSessionTracker(): CollaborativeSessionTracker {
  if (!globalCollaborativeSessionTracker) {
    globalCollaborativeSessionTracker = new CollaborativeSessionTracker()
  }
  return globalCollaborativeSessionTracker
}

/**
 * Set the global collaborative session tracker (mainly for testing).
 */
export function setGlobalCollaborativeSessionTracker(
  tracker: CollaborativeSessionTracker | null
): void {
  globalCollaborativeSessionTracker = tracker
}
