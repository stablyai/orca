/**
 * What a bridged-replay divergence is called, decided by a rule rather than by reading a message.
 *
 * Beside the recorder rather than inside it. Reading a failure cannot change what a recording
 * records, so `recorderSha256` must not cover this: a tightened rule would otherwise re-record 787
 * headers to say nothing. The recorder's own directory is digested whole, which is why this lives
 * one level up in `test-support`.
 */

/** Named once so the suite, its pin and the CI job cannot drift apart. */
export const BRIDGED_PARITY_FLAG = 'RPC_FOUNDATION_BRIDGE'

export type BridgedParityClass =
  | 'reply-meta-required'
  | 'result-absent-settlement'
  | 'result-absent-observation'
  | 'result-absent-stream-release'
  | 'params-undefined'
  | 'write-ordinal'
  | 'unclassified'

/**
 * The throw, when it was the scripted transport refusing a request's params, read into key paths.
 *
 * `step` is the name the transport printed, `method#occurrence`. The two lists are the ones the
 * rule needs: the message alone says nothing, because it is the same message whatever moved the
 * params, and ten scenarios script an `undefined` key for a bridge to drop.
 */
export type ParamsMismatchEvidence = {
  step: string
  /** Paths into the params the scenario scripts whose own value is `undefined`. */
  undefinedValuedKeys: readonly string[]
  /** Every path where the params that arrived differ from the ones the scenario scripts. */
  differingKeys: readonly string[]
}

export type BridgedParityEvidence = {
  /**
   * The same replay, with `_meta` supplied on every reply the shell posted, came out byte-identical
   * once that field is discounted. Measured rather than inferred: a golden can be refused a reply
   * for the missing field and still diverge for a second reason, and only the counterfactual run
   * separates the two.
   */
  fixedByReplyMeta: boolean
  /** The run threw before there was a recording to compare. */
  threwWhileRecording: boolean
  /**
   * Field paths that differ, in the order `compareGolden` walks them, or `checkpoints` when the
   * checkpoint lists themselves do. Only the first names the golden: it is the divergence that
   * takes the replay off course, and everything after it is a consequence of a run that is already
   * somewhere else. The rest is kept because a failure that has to be read wants all of it.
   */
  divergingFields: readonly string[]
  /** The scenario scripts a reply that is `ok` and carries no `result` key. */
  scriptsAbsentResultReply: boolean
  /** Null unless the throw was the scripted transport refusing one request's params. */
  paramsMismatch: ParamsMismatchEvidence | null
  /** The page refused a frame on a stream it held and released that stream because of it. */
  refusalReleasedStream: boolean
}

/**
 * Every param that moved is one the scenario valued `undefined`, and at least one moved.
 *
 * Both halves are load-bearing. Without the first, any failure inside the ten scenarios that script
 * such a key is called this class: a seeded wire bug that put one extra own key on every request's
 * params threw this same message, stayed inside those ten, and was counted and never reported.
 * Without the second, a throw that named the step but moved nothing would be excluded on the
 * strength of a key the run never touched.
 */
function movedOnlyKeysScriptedUndefined(mismatch: ParamsMismatchEvidence | null): boolean {
  if (mismatch === null || mismatch.differingKeys.length === 0) {
    return false
  }
  return mismatch.differingKeys.every((key) => mismatch.undefinedValuedKeys.includes(key))
}

function settlementField(path: string): boolean {
  return path.endsWith('.settlement') || path.includes('.settlement.')
}

function ordinalField(path: string): boolean {
  return path.endsWith('.ordinal')
}

/**
 * Exactly one name per diverging golden, in this order and no other.
 *
 * The first arm is the only one that needs a second run, and it has to come first because it is the
 * only one that is a cause rather than a symptom: nearly every golden here is refused some reply
 * for the missing field, and only the run that supplies it says which of them the field explains.
 * Everything below is a property of the scenario, of the fields that moved, or of the frames the
 * page posted. The one arm that has no recording to read — the run that threw before there was
 * one — is the one arm that reads the throw, and it reads it only far enough to find the step the
 * transport named, then compares the params on their own.
 */
export function classifyBridgedParity(evidence: BridgedParityEvidence): BridgedParityClass {
  if (evidence.fixedByReplyMeta) {
    return 'reply-meta-required'
  }
  if (evidence.threwWhileRecording) {
    if (movedOnlyKeysScriptedUndefined(evidence.paramsMismatch)) {
      return 'params-undefined'
    }
    return evidence.scriptsAbsentResultReply && evidence.refusalReleasedStream
      ? 'result-absent-stream-release'
      : 'unclassified'
  }
  const [first] = evidence.divergingFields
  if (first === undefined) {
    return 'unclassified'
  }
  // Before the partition below, not after: a reply shape the page drops cannot move a write
  // ordinal, so an ordinal that moved first is the bridge's hop and not the partition's doing. Most
  // of the matrix carries an absent-result reply somewhere, and testing that first would swallow
  // every ordinal finding in the corpus.
  if (ordinalField(first)) {
    return 'write-ordinal'
  }
  if (evidence.scriptsAbsentResultReply) {
    return settlementField(first) ? 'result-absent-settlement' : 'result-absent-observation'
  }
  return 'unclassified'
}

/**
 * Why a class the run still counts is a bound on the claim rather than a defect left open.
 *
 * A class with an entry here is one the suite is allowed to see; a class without one has to be
 * zero, which is what `reply-meta-required` became. Each reason is a property of the recorder or of
 * the wire, measured rather than argued, so it can be checked without rerunning anything.
 */
export const BRIDGED_PARITY_EXCLUSIONS: Readonly<Partial<Record<BridgedParityClass, string>>> = {
  'result-absent-settlement':
    'the recorder injects `{ ok: true }` with no `result` at the scripted sender port, below the ' +
    'frame validation both sides do; `isRpcResponse` drops that shape too, so no real frame ' +
    'boundary carries it and byte-identical replay is unavailable at any bridge',
  'result-absent-observation':
    'the same injection, seen first as a different checkpoint set or a lost effect rather than as ' +
    'the settlement that never arrives',
  'result-absent-stream-release':
    'the same injection delivered on a stream: the page refuses the frame and releases a stream ' +
    'the shell is still serving, so it posts the `cancel` that is the only thing releasing the ' +
    "shell's slot, and the unsubscribe that publishes renames the recorder's later occurrences " +
    'before there is a recording to compare — the native client never refuses the frame, so it ' +
    'never reaches the release at all',
  'params-undefined':
    'an own property valued `undefined` is already absent from the bytes the native run puts on ' +
    'the wire, so the bridged run sends the identical frame; what differs is the pre-serialization ' +
    'object a scenario step is matched against, which is above the altitude any transport has',
  'write-ordinal':
    'not a reorder on the wire: the page posts its frames in call order and the payloads publish ' +
    'in that order, but the logical `sendRequest` stamp and each device effect happen at the call ' +
    'while a same-turn `subscribe` payload publishes one delivery later'
}

/**
 * What this tree measures, per class, over all 787 goldens.
 *
 * A ratchet, not a description: the flagged run fails when a class grows past its number here, when
 * anything lands in `unclassified`, or when fewer goldens replay byte-identically than this says.
 * Each class is an upper bound and `identical` a lower one, and this module's test pins the sum of
 * every number below to the size of the corpus — which is what stops one class being loosened on
 * its own, since a class that grows has to be paid for out of another.
 *
 * `identical` only moves up and a class only moves down, with one exception that is not a
 * regression. Two excluded classes can trade members when a fix changes which difference a run
 * meets first, and then both numbers move here at once, in opposite directions, leaving the sum
 * alone. That trade cannot hide a golden that stopped replaying byte-identically, because such a
 * golden takes `identical` down with it and the run refuses that outright.
 */
export const BRIDGED_PARITY_BASELINE: Readonly<Record<BridgedParityClass | 'identical', number>> = {
  identical: 396,
  // Closed by the `_meta` widening: the page's reader is `isRpcResponse` itself.
  'reply-meta-required': 0,
  // Settling a refused reply moved three goldens here out of `write-ordinal`: a rejection that
  // now arrives differs before the ordinal that also moved does. Nothing stopped replaying
  // identically, and the corpus is a fixed size, so a shuffle between two excluded classes cannot
  // hide one.
  'result-absent-settlement': 341,
  // Four left here and two left `write-ordinal` for the class below, which is the `cancel` a
  // refused stream frame now posts: the run stops at a renamed occurrence before it reaches the
  // checkpoint or the ordinal that used to be what differed first.
  'result-absent-observation': 3,
  'result-absent-stream-release': 6,
  'params-undefined': 33,
  'write-ordinal': 8,
  unclassified: 0
}

/** A class this small is named golden by golden in the run's output rather than counted. */
export const BRIDGED_PARITY_NAMEABLE = 8

/**
 * Which goldens are in each class small enough to name, so the pin holds membership and not a count.
 *
 * A count alone is blind to a trade. Every predicate above reads the scenario rather than the
 * refused frame — `scriptsAbsentResultReply` asks whether the scenario scripts the injected shape
 * anywhere, not whether the frame the page refused was one — so a real refusal inside a stream
 * golden is named an excluded class. One golden leaving that class as the real refusal puts another
 * in moves no number here, and the sum and the `identical` floor both still hold. The ids are what
 * notices. Where a class is too large to list, its predicate stands on its own and the count is all
 * the pin has; that is why the classes here are the small ones and why the test above requires
 * every class of `BRIDGED_PARITY_NAMEABLE` or fewer to appear.
 */
export const BRIDGED_PARITY_MEMBERS: Readonly<
  Partial<Record<BridgedParityClass, readonly string[]>>
> = {
  'result-absent-observation': [
    'matrix-notifications.desktop-stream-notifications.subscribe-1-1',
    'matrix-notifications.desktop-stream-notifications.subscribe-1-2',
    'matrix-session.native-chat-page-nativechat.subscribe-2-1'
  ],
  'result-absent-stream-release': [
    'matrix-live-worktree-name-runtime.clientevents.subscribe-1-1',
    'matrix-live-worktree-name-runtime.clientevents.subscribe-1-2',
    'matrix-host-worktree-refresh-runtime.clientevents.subscribe-1-1',
    'matrix-host-worktree-refresh-runtime.clientevents.subscribe-1-2',
    'matrix-host-worktree-refresh-runtime.clientevents.subscribe-1-3',
    'matrix-session.native-chat-page-nativechat.subscribe-1-1'
  ],
  'write-ordinal': [
    'settings-home-coalesced',
    'live-worktree-name-stream',
    'host-worktree-refresh-stream',
    'matrix-live-worktree-name-worktree.show-1',
    'matrix-live-worktree-name-worktree.show-2',
    'matrix-live-worktree-name-runtime.clientevents.subscribe-2-1',
    'matrix-live-worktree-name-worktree.show-3',
    'matrix-host-worktree-refresh-runtime.clientevents.subscribe-2-1'
  ]
}

/**
 * Each pinned class whose goldens are not the ones it is pinned to, said in one line.
 *
 * Both directions are reported. A golden that arrived is the finding; a golden that left is what
 * paid for it, and a class that empties is a fix whose edit belongs here beside the count.
 */
export function bridgedParityMembershipDrift(
  observed: ReadonlyMap<string, readonly string[]>
): readonly string[] {
  const drift: string[] = []
  for (const [name, pinned] of Object.entries(BRIDGED_PARITY_MEMBERS)) {
    if (pinned === undefined) {
      continue
    }
    const seen = observed.get(name) ?? []
    const arrived = seen.filter((id) => !pinned.includes(id))
    const left = pinned.filter((id) => !seen.includes(id))
    if (arrived.length > 0 || left.length > 0) {
      drift.push(
        `${name}: arrived ${arrived.join(', ') || '(none)'}; left ${left.join(', ') || '(none)'}`
      )
    }
  }
  return drift
}
