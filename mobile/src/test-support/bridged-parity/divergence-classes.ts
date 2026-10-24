/**
 * What a bridged-replay divergence is called, decided by a rule rather than by reading a message.
 *
 * Beside the recorder rather than inside it: reading a failure cannot change what a recording
 * records, and nothing on the recording path loads this.
 */

/**
 * The switch that turns the bridged replay off, named once so the suite and its pin cannot drift.
 *
 * It used to be what turned the replay *on*, and CI set it. That made the gate opt-in, which is the
 * one thing a gate must not be: a branch that widened the bridge's divergence and left the variable
 * alone would have been measured by nobody. The replay is the default now and `=0` is for a local
 * run that does not want the three minutes. CI sets nothing.
 */
export const BRIDGED_PARITY_FLAG = 'RPC_FOUNDATION_BRIDGE'

/** The one value of it that skips the suite; anything else, unset included, runs it. */
export const BRIDGED_PARITY_OFF = '0'

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
   * Every differing leaf, plus checkpoint-list disagreement. No first-path shortcut can certify
   * that later siblings are ordinal-only or consequences of a malformed exchange.
   */
  divergingFields: readonly string[]
  /** Every nonordinal difference was traced to its own injected exchange and actual refusal. */
  absentResultExplainsResiduals: boolean
  /** Null unless the throw was the scripted transport refusing one request's params. */
  paramsMismatch: ParamsMismatchEvidence | null
  /** The page refused a frame on a stream it held and released that stream because of it. */
  refusalReleasedStream: boolean
  /** Unchanged corpus membership only; these legacy labels do not certify causal parity. */
  legacyBaseline?: { firstField: string | undefined; scriptsAbsentResultReply: boolean }
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

export function ordinalField(path: string): boolean {
  return /^(sender|payloads|effects)\[\d+\]\.ordinal$/.test(path)
}

/** Strict residual certification, or the explicitly requested unchanged-corpus legacy label. */
export function classifyBridgedParity(evidence: BridgedParityEvidence): BridgedParityClass {
  if (evidence.fixedByReplyMeta) {
    return 'reply-meta-required'
  }
  if (evidence.threwWhileRecording) {
    if (movedOnlyKeysScriptedUndefined(evidence.paramsMismatch)) {
      return 'params-undefined'
    }
    return evidence.refusalReleasedStream ? 'result-absent-stream-release' : 'unclassified'
  }
  const legacy = evidence.legacyBaseline
  if (legacy !== undefined) {
    if (legacy.firstField === undefined) {
      return 'unclassified'
    }
    if (legacy.firstField.endsWith('.ordinal')) {
      return 'write-ordinal'
    }
    return legacy.scriptsAbsentResultReply
      ? settlementField(legacy.firstField)
        ? 'result-absent-settlement'
        : 'result-absent-observation'
      : 'unclassified'
  }
  if (evidence.divergingFields.length === 0) {
    return 'unclassified'
  }
  const residuals = evidence.divergingFields.filter((path) => !ordinalField(path))
  if (residuals.length === 0) {
    return 'write-ordinal'
  }
  if (evidence.absentResultExplainsResiduals) {
    return settlementField(residuals[0]!) ? 'result-absent-settlement' : 'result-absent-observation'
  }
  return 'unclassified'
}

/**
 * Known recorder limitations. For unchanged corpus members these describe legacy labels, not
 * complete causal proofs. Changed History members require exact residual attribution above.
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

/** Measured membership counts: strict History verdicts plus unchanged legacy baseline labels. */
export const BRIDGED_PARITY_BASELINE: Readonly<Record<BridgedParityClass | 'identical', number>> = {
  identical: 396,
  'reply-meta-required': 0,
  'result-absent-settlement': 350,
  'result-absent-observation': 3,
  'result-absent-stream-release': 6,
  'params-undefined': 27,
  'write-ordinal': 13,
  unclassified: 0
}

/** What one run of the suite counted: the byte-identical goldens, and the diverging ones by class. */
export type BridgedParityTally = {
  identical: number
  counts: Readonly<Record<BridgedParityClass, number>>
}

/**
 * Every number a run reported that `BRIDGED_PARITY_BASELINE` does not, said in one line each.
 *
 * Both directions, and `identical` on the same footing as a class, because that is the direction
 * nothing else in the suite sees. A golden reported `identical` instead of the excluded class it
 * belongs to leaves `unclassified` empty, leaves every diverging golden inside a class the
 * exclusions name, and leaves the corpus its size: this is the only number that moves.
 */
export function bridgedParityTallyDrift(tally: BridgedParityTally): readonly string[] {
  const ran: Readonly<Record<string, number>> = { ...tally.counts, identical: tally.identical }
  const drift: string[] = []
  for (const [name, pinned] of Object.entries(BRIDGED_PARITY_BASELINE)) {
    const count = ran[name] ?? 0
    if (count !== pinned) {
      drift.push(`${name}: pinned ${pinned}, ran ${count}`)
    }
  }
  return drift
}

/** A class this small is named golden by golden in the run's output rather than counted. */
export const BRIDGED_PARITY_NAMEABLE = 8

/** Small-class membership plus the measured strict ordinal History controls. */
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
    'aivault-history-scan-fulfilled',
    'aivault-history-scan-unsupported',
    'aivault-history-scan-worktrees-late',
    'aivault-history-screen-listed',
    'aivault-history-screen-worktrees',
    'host-worktree-refresh-stream',
    'live-worktree-name-stream',
    'matrix-host-worktree-refresh-runtime.clientevents.subscribe-2-1',
    'matrix-live-worktree-name-runtime.clientevents.subscribe-2-1',
    'matrix-live-worktree-name-worktree.show-1',
    'matrix-live-worktree-name-worktree.show-2',
    'matrix-live-worktree-name-worktree.show-3',
    'settings-home-coalesced'
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
