// Keep divergence analysis outside the recorder so classification cannot change the evidence it reads.

// Replay is enabled by default; explicit zero opts out locally so CI cannot silently skip the gate.
export const BRIDGED_PARITY_FLAG = 'RPC_FOUNDATION_BRIDGE'

export const BRIDGED_PARITY_OFF = '0'

export type BridgedParityClass =
  | 'reply-meta-required'
  | 'result-absent-settlement'
  | 'result-absent-observation'
  | 'result-absent-stream-release'
  | 'params-undefined'
  | 'write-ordinal'
  | 'unclassified'

// A params-mismatch message alone cannot distinguish undefined-key loss from real corruption; record both scripted and changed paths.
export type ParamsMismatchEvidence = {
  step: string
  undefinedValuedKeys: readonly string[]
  differingKeys: readonly string[]
}

export type BridgedParityEvidence = {
  // Supply reply meta in a counterfactual run to isolate that cause from other divergences.
  fixedByReplyMeta: boolean
  threwWhileRecording: boolean
  // Classify by the first differing field; retain all paths for diagnosis and distinguish missing checkpoints.
  divergingFields: readonly string[]
  scriptsAbsentResultReply: boolean
  paramsMismatch: ParamsMismatchEvidence | null
  refusalReleasedStream: boolean
}

// Require at least one changed key and all changes to be scripted undefined; otherwise unrelated params bugs would be excluded.
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

// Test counterfactual causes before symptoms, then classify only evidence from the actual run.
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
  // Ordinal-first divergence is real bridge scheduling; checking absent-result partitions first would swallow it.
  if (ordinalField(first)) {
    return 'write-ordinal'
  }
  if (evidence.scriptsAbsentResultReply) {
    return settlementField(first) ? 'result-absent-settlement' : 'result-absent-observation'
  }
  return 'unclassified'
}

// Only explicitly documented recorder/wire artifacts may be excluded; every other class must stay zero.
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

// Pin exact totals in both directions, including identical; one exclusion class shrinking can otherwise hide another growing.
export const BRIDGED_PARITY_BASELINE: Readonly<Record<BridgedParityClass | 'identical', number>> = {
  identical: 401,
  'reply-meta-required': 0,
  'result-absent-settlement': 350,
  'result-absent-observation': 3,
  'result-absent-stream-release': 6,
  'params-undefined': 27,
  'write-ordinal': 8,
  unclassified: 0
}

export type BridgedParityTally = {
  identical: number
  counts: Readonly<Record<BridgedParityClass, number>>
}

// Check both directions and identical too; broad unclassified/exclusion gates cannot detect every class trade.
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

export const BRIDGED_PARITY_NAMEABLE = 8

// Pin small classes by membership because unchanged counts can hide one real failure replacing an excluded artifact.
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
