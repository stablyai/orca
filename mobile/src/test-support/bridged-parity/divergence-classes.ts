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
  // Certify every differing leaf and require causal evidence for all nonordinal residuals.
  divergingFields: readonly string[]
  absentResultExplainsResiduals: boolean
  paramsMismatch: ParamsMismatchEvidence | null
  refusalReleasedStream: boolean
  /** Unchanged corpus membership only; these legacy labels do not certify causal parity. */
  legacyBaseline?: { firstField: string | undefined; scriptsAbsentResultReply: boolean }
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

export function ordinalField(path: string): boolean {
  return /^(sender|payloads|effects)\[\d+\]\.ordinal$/.test(path)
}

// Certify complete residuals unless an unchanged corpus member requests its legacy label.
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
  // Only ordinal residuals may receive the ordinal class.
  const residuals = evidence.divergingFields.filter((path) => !ordinalField(path))
  if (residuals.length === 0) {
    return 'write-ordinal'
  }
  if (evidence.absentResultExplainsResiduals) {
    return settlementField(residuals[0]!) ? 'result-absent-settlement' : 'result-absent-observation'
  }
  return 'unclassified'
}

// Changed History goldens require causal evidence; unchanged corpus labels retain their legacy limits.
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
