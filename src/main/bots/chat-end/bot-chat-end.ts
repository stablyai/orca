// Ends one of a bot's side chats only when it is provably at rest and owes nothing; otherwise keeps it
// as it was (with "x", in the background as a closed tab always did). The order matters:
//   1. what it owes, read before anything changes, so an ineligible chat's agent is never stopped;
//   2. the idle sweep's own early release, which confirms the exact agent idle and stops it;
//   3. one synchronous tick that proves the chat at rest and fences new work for it;
//   4. while fenced, the saved usage-limit cut and restart offer, which a turn would be needed to change;
//   5. one guarded write that takes its tab and background hold away and marks it ended.
// Nothing is released, settled or dropped, so reopening the chat restores all an end changed.
import type { BotChatEndReason, BotChatEndResult } from '../../../shared/bots/bot-chat-end'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { structuredAgentSessionOwnerUnverifiable } from '../../native-chat/agent-session-wire/observations/structured-agent-session-work-policy'
import { readSavedUsageLimitCut } from '../../native-chat/agent-session-wire/recovery/structured-agent-session-usage-limit-chain'
import {
  captureStructuredSessionSurface,
  retireCapturedStructuredSessionSurface,
  type StructuredSessionSurface,
  type StructuredSessionSurfaceRuntime
} from '../../runtime/agent-session/lifecycle/structured-agent-session-close'
import type { BotChatEndTarget, BotChatEndTargetLookup } from './bot-chat-end-target'
import {
  fenceChatEnd,
  holdChatEndUntilRestart,
  isChatEndUnresolved,
  liftChatEndFence
} from './bot-chat-end-fence'

export type BotChatEndDeps = {
  host: StructuredAgentSessionHost
  runtime: StructuredSessionSurfaceRuntime
  /** The chat as it stands now; synchronous, so the fence tick and the write's check repeat it. */
  lookUp: () => BotChatEndTargetLookup
  /** What it owes now; synchronous. Throws when a source can't be read. */
  owes: (lineage: readonly string[]) => BotChatEndReason[]
  /** An idle edge for its mail, after an end that did not happen. */
  redrive: (sessionId: string) => void
}

export type BotChatEndRequest = {
  intent: 'x' | 'end'
  /** The session whose tab the person closed (`x`). */
  sessionId: string
  showing?: string
}

function owed(deps: BotChatEndDeps, lineage: readonly string[]): BotChatEndReason[] {
  try {
    return deps.owes(lineage)
  } catch {
    return [{ kind: 'unreadable' }]
  }
}

/** No session open and no work owed without one (the automatic close's resting read), and its
 *  claim released with proof the agent exited or never started. */
function atRest(host: StructuredAgentSessionHost, target: BotChatEndTarget): boolean {
  if (target.lineage.some((id) => host.hasSession(id) || host.reads.owesUnloadedWork(id))) {
    return false
  }
  const record = host.deps.store.getConversation(target.live)
  return (
    record?.ownerObservation.claimStatus === 'released' &&
    (record.ownerObservation.deathEvidence !== null || record.neverStarted) &&
    !structuredAgentSessionOwnerUnverifiable({ record, child: null })
  )
}

/** The fence tick and the write's check: the same chat, the same showing, at rest, owing nothing. */
function admissionReasons(
  deps: BotChatEndDeps,
  target: BotChatEndTarget,
  showing: string | null
): BotChatEndReason[] {
  const now = deps.lookUp()
  if (
    now.kind !== 'found' ||
    now.target.live !== target.live ||
    deps.host.deps.store.getSessionTabShowing(target.live) !== showing
  ) {
    return [{ kind: 'reopened' }]
  }
  if (!atRest(deps.host, target)) {
    return [{ kind: 'stopping' }]
  }
  return owed(deps, target.lineage)
}

/** Owed work a turn would be needed to change: read while fenced, so none can start meanwhile. */
async function fencedReasons(
  host: StructuredAgentSessionHost,
  sessionId: string
): Promise<BotChatEndReason[]> {
  try {
    const cut = await readSavedUsageLimitCut(host.deps.journalDatabase, sessionId)
    const cancel = host.deps.store.getRecord(sessionId)?.usageLimitContinueCancel
    if (cut && !(cancel?.turnItemId === cut.turnItemId && cancel.resetsAt === cut.resetsAt)) {
      return [{ kind: 'usage-continue' }]
    }
    return (await host.restartResume.cutOf(sessionId)) ? [{ kind: 'restart-offer' }] : []
  } catch {
    return [{ kind: 'unreadable' }]
  }
}

/** With `x`, a chat that can't end goes to the background, as long as the closed tab still shows. */
async function keep(
  deps: BotChatEndDeps,
  request: BotChatEndRequest,
  surface: StructuredSessionSurface | null,
  kept: Extract<BotChatEndResult, { outcome: 'kept' | 'refused' }>
): Promise<BotChatEndResult> {
  if (request.intent !== 'x') {
    return kept
  }
  const { host, runtime } = deps
  const written = await retireCapturedStructuredSessionSurface(
    host,
    request.sessionId,
    surface ?? captureStructuredSessionSurface(host, request.sessionId, runtime),
    runtime,
    true,
    { admit: () => host.deps.store.getSessionTabShowing(request.sessionId) === request.showing }
  )
  if (written.error !== undefined) {
    return { outcome: 'unknown' }
  }
  return written.committed ? { ...kept, background: true } : { outcome: 'superseded' }
}

export async function endBotChat(
  deps: BotChatEndDeps,
  request: BotChatEndRequest
): Promise<BotChatEndResult> {
  const { host } = deps
  const store = host.deps.store
  if (request.intent === 'x' && store.getSessionTabShowing(request.sessionId) !== request.showing) {
    return { outcome: 'superseded' }
  }
  const first = deps.lookUp()
  if (first.kind !== 'refused' && first.target.lineage.some(isChatEndUnresolved)) {
    return { outcome: 'unknown' }
  }
  if (first.kind === 'already-ended') {
    return { outcome: 'already-ended' }
  }
  if (first.kind === 'refused') {
    return keep(deps, request, null, { outcome: 'refused', refusal: first.refusal })
  }
  const { target } = first
  const showing = store.getSessionTabShowing(target.live)
  const surface = captureStructuredSessionSurface(host, target.live, deps.runtime)
  const before = owed(deps, target.lineage)
  if (before.length > 0) {
    return keep(deps, request, surface, { outcome: 'kept', reasons: before })
  }
  const seen = await host.releaseIdleSession(target.live, true)
  const tick =
    seen === 'released'
      ? admissionReasons(deps, target, showing)
      : [{ kind: seen === 'busy' ? 'replying' : 'stopping' } as const]
  if (tick.length > 0) {
    return keep(deps, request, surface, { outcome: 'kept', reasons: tick })
  }
  fenceChatEnd(target.lineage)
  let ended = false
  try {
    const later = await fencedReasons(host, target.live)
    if (later.length > 0) {
      return await keep(deps, request, surface, { outcome: 'kept', reasons: later })
    }
    let refused: BotChatEndReason[] = []
    const written = await retireCapturedStructuredSessionSurface(
      host,
      target.live,
      surface,
      deps.runtime,
      false,
      {
        end: true,
        admit: () => {
          refused = admissionReasons(deps, target, showing)
          return refused.length === 0
        }
      }
    )
    if (written.error !== undefined) {
      holdChatEndUntilRestart(target.lineage)
      return { outcome: 'unknown' }
    }
    if (!written.committed) {
      const reasons: BotChatEndReason[] = refused.length > 0 ? refused : [{ kind: 'reopened' }]
      return await keep(deps, request, surface, { outcome: 'kept', reasons })
    }
    ended = true
    return { outcome: 'ended', title: target.title }
  } finally {
    liftChatEndFence(target.lineage)
    if (!ended) {
      deps.redrive(target.live)
    }
  }
}
