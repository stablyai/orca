// Who finishes a pane's RPC release once the renderer cannot.
//
// Why main needs a continuation at all (XLR-R6-003, cross-lab review): pane
// cleanup asks for the release a bounded number of times
// (omp-rpc-pane-release-obligation.ts) and that bound is deliberate — a pane
// whose child is protocol-faulted with an unprovable exit can never resolve,
// and an unbounded renderer loop spun release plus exit-proof cycles for the
// app's life. But a pane closed or rebound DURING a healthy turn longer than
// those windows is a different case: every attempt is refused because live work
// is fail-closed, the loop is spent, and nothing else was left holding the
// obligation. A closed pane cannot reclaim it through a later acquire either,
// so the child, its claim, and its session-file exclusion survived until app
// exit — and every other pane stayed excluded from a session nobody writes.
//
// Main is the only side that can see the turn end, so main holds the remainder:
// the release is re-attempted when the session's own frames say it settled — or,
// for a command that reports through no frame at all, when the session says its
// round trip finished (XLR-R7-002, below).
// Re-armed only on a FRESH frame, never on the terminal state the session
// replays to a new subscriber (omp-rpc-chat-session.ts) — a retained
// `protocol-fault` would otherwise re-trigger a refusal-and-re-arm cycle as
// fast as promises resolve, which is exactly the spin the renderer's bound
// exists to prevent.

import type {
  OmpRpcChatHandbackPayload,
  OmpRpcChatHandbackRespawnContext
} from '../../shared/omp-rpc-chat-ipc-contract'
import type { OmpRpcClientEvent } from '../../shared/omp-rpc-protocol'
import type { OmpRpcChatSession } from './omp-rpc-chat-session'
import type {
  OmpRpcChatReleaseResult,
  OmpRpcChatSessionRegistry
} from './omp-rpc-chat-session-registry'

/** The frames that mean the work a refused release fail-closed on is over: the
 *  turn ended, or the child itself is gone. An `exit` counts because the release
 *  the child's SIGTERM-delayed death refused becomes provable exactly then.
 *  `prompt-result` counts too (XLR-R7-002, cross-lab review): a prompt that
 *  started no agent turn reports its outcome through that frame and no other,
 *  so nothing else here would ever speak for it. */
function isOmpRpcReleaseRetryFrame(event: OmpRpcClientEvent): boolean {
  return (
    event.kind === 'agent-end' ||
    event.kind === 'turn-end' ||
    event.kind === 'prompt-result' ||
    event.kind === 'exit' ||
    event.kind === 'protocol-fault'
  )
}

type DeferredRelease = {
  paneKey: string
  session: OmpRpcChatSession
  registeredSession: () => OmpRpcChatSession | null
  release: () => Promise<OmpRpcChatReleaseResult>
  onReleased: (result: OmpRpcChatReleaseResult) => void
}

/** At most one armed continuation per pane. The renderer's bounded cleanup
 *  fires several refused releases back to back, and one listener each would all
 *  wake on the same settlement, JOIN main's single release (it is single-flight)
 *  and then each push a hand-back of its own — several `omp --resume` children
 *  launched against one session before the layout staleness checks could reap
 *  them, which is the single-writer overlap this feature is proof-gated to
 *  prevent. */
const armedByPaneKey = new Map<string, DeferredRelease>()

/** Re-attempts `release` when the session reports the turn settled, or the
 *  child exits. Re-arms ignore a retained protocol fault, but retain an exit:
 *  an exit that landed during the failed-release gap is fresh proof that the
 *  child is gone and must not strand its claim. */
export function deferOmpRpcPaneReleaseUntilSettled(
  deferred: DeferredRelease,
  actOnReplayedFrame = true
): void {
  const alreadyArmed = armedByPaneKey.get(deferred.paneKey)
  if (alreadyArmed?.session === deferred.session) {
    // One listener still, and the newest caller's hand-back is the one owed:
    // it carries whatever respawn context that release actually asked for.
    alreadyArmed.onReleased = deferred.onReleased
    return
  }
  armedByPaneKey.set(deferred.paneKey, deferred)
  // A mutable holder because `session.on` can call the listener synchronously
  // (replayed terminal state), before a `const` for the unsubscribe is bound.
  const armed = { stop: null as (() => void) | null, fired: false, attached: false }
  const settled = (): void => {
    armed.fired = true
    armed.stop?.()
    // Only if this record is still the pane's: a successor's arm replaced it.
    if (armedByPaneKey.get(deferred.paneKey) === deferred) {
      armedByPaneKey.delete(deferred.paneKey)
    }
    void continueOmpRpcPaneRelease(deferred)
  }
  const stopFrames = deferred.session.on((event) => {
    if (armed.fired || !isOmpRpcReleaseRetryFrame(event)) {
      return
    }
    if (!armed.attached && !actOnReplayedFrame && event.kind === 'protocol-fault') {
      return
    }
    settled()
  })
  // Why a second source (XLR-R7-002): a release can be refused for command
  // identity alone, and a local-only slash or extension command reports its
  // completion through NO frame — it runs no agent, and a read-back that
  // confirms the same session publishes nothing. Identity would be settled with
  // main never retrying, keeping the child, its claim, its session-file
  // exclusion and the pane's null PTY binding for the app's life. This signal
  // is never replayed, so it cannot drive the spin the frame path guards.
  const stopCommands = deferred.session.onCommandSettled(() => {
    if (!armed.fired) {
      settled()
    }
  })
  armed.stop = () => {
    stopFrames()
    stopCommands()
  }
  armed.attached = true
  if (armed.fired) {
    armed.stop()
  }
}

async function continueOmpRpcPaneRelease(deferred: DeferredRelease): Promise<void> {
  // Identity, not just presence: a pane that re-acquired in the meantime owns a
  // different child, and releasing by paneKey would tear down the live one. Its
  // own acquire already reclaimed whatever this obligation was holding.
  if (deferred.registeredSession() !== deferred.session) {
    return
  }
  const result = await deferred.release()
  if (result.released) {
    deferred.onReleased(result)
    return
  }
  if (deferred.registeredSession() === deferred.session) {
    deferOmpRpcPaneReleaseUntilSettled(deferred, false)
  }
}

/** One pane release, plus the hand-back push a settled one earns and the
 *  continuation a refused one leaves behind.
 *
 *  Why the push is gated on `released` (Critical B, wave 5): a fail-closed
 *  release (turn still streaming) keeps the claim, and respawning a PTY beside
 *  a child that may still be writing the session is the single-writer violation
 *  this feature is proof-gated to prevent. The continuation above is what makes
 *  that refusal temporary rather than permanent. */
export async function releaseOmpRpcPaneWithHandback(args: {
  paneKey: string
  registry: OmpRpcChatSessionRegistry
  respawn?: OmpRpcChatHandbackRespawnContext
  sendHandback: (payload: OmpRpcChatHandbackPayload) => void
}): Promise<{ released: boolean }> {
  const { paneKey, registry, respawn, sendHandback } = args
  const pushHandback = (sessionId?: string): void => {
    if (!respawn) {
      return
    }
    // Why the proven identity (XLR-019): a supported command may have switched
    // the child's session since acquisition, and main's read-back is the only
    // proof of which one. The caller's own id is the fallback for a child that
    // died before reporting one.
    sendHandback({
      paneKey,
      replacedPtyId: respawn.replacedPtyId,
      cwd: respawn.cwd,
      sessionId: sessionId ?? respawn.sessionId
    })
  }
  const result = await registry.release(paneKey)
  if (result.released) {
    pushHandback(result.sessionId)
    return { released: true }
  }
  const session = registry.get(paneKey)
  if (session) {
    deferOmpRpcPaneReleaseUntilSettled({
      paneKey,
      session,
      registeredSession: () => registry.get(paneKey),
      release: () => registry.release(paneKey),
      onReleased: (settled) => pushHandback(settled.sessionId)
    })
  }
  return { released: false }
}
