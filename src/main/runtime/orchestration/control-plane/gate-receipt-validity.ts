import type { ControlPlaneStore, GateReceiptRow } from './control-plane-store'
import { hasUnprovableDependency } from './gate-dependency-fingerprint'

/** B8 — a gate receipt binds the deterministic inputs that produced it, so a
 *  later run can reuse it only when it can prove nothing those inputs cover has
 *  changed.
 *
 *  State machine (one receipt per gate per scope):
 *    trigger                 immediate state  writer             next state
 *    ----------------------------------------------------------------------
 *    gate runs               recorded         recordGateReceipt  reusable
 *    inputs unchanged        reusable         canReuseGateReceipt reused
 *    any bound input changes reusable         canReuseGateReceipt invalidated → rerun
 *    high-risk policy        any              canReuseGateReceipt invalidated → rerun
 *  Idempotency: `receipt_id` is derived from the bound inputs, so re-recording
 *  the same gate result is a replace, not a duplicate.
 */

export type GateRiskPolicy = 'standard' | 'high_risk'

/** How a gate's receipt relates to the commit it was earned on.
 *
 *  `content` gates prove something about their declared inputs, so a receipt
 *  survives an unrelated commit whose dependency fingerprint is unchanged.
 *  `exact_head` gates prove something about the commit ITSELF — publication and
 *  review gates — so their receipt dies with the SHA and is never reused. */
export type GateShaBinding = 'content' | 'exact_head'

export type GateInputs = {
  gateId: string
  finalSha: string
  /** Content hashes of the actual bytes of every input this gate depends on,
   *  keyed by dependency. Per gate: a gate is invalidated only by ITS OWN
   *  dependencies changing. */
  inputHashes: Readonly<Record<string, string>>
  policyVersion: string
  commandIdentity: string
  /** Defaults to `content`; publication/review gates declare `exact_head`. */
  shaBinding?: GateShaBinding
}

export type GateReceipt = GateInputs & {
  result: 'PASS' | 'FAIL'
  recordedAt: string
}

export type GateReuseVerdict =
  | { reuse: true; receipt: GateReceipt }
  | {
      reuse: false
      code:
        | 'no_receipt'
        | 'sha_changed'
        | 'inputs_changed'
        | 'policy_version_changed'
        | 'command_changed'
        | 'receipt_failed'
        | 'high_risk_policy'
        | 'dependency_unreadable'
      reason: string
    }

export function gateReceiptId(inputs: GateInputs): string {
  return [
    inputs.gateId,
    // Why the SHA only for exact-head gates: including it for a content gate
    // would mint a new receipt id every commit and defeat reuse entirely.
    shaBindingOf(inputs) === 'exact_head' ? inputs.finalSha : 'content',
    inputs.policyVersion,
    inputs.commandIdentity,
    stableHashes(inputs.inputHashes)
  ].join('#')
}

export function shaBindingOf(inputs: GateInputs): GateShaBinding {
  return inputs.shaBinding ?? 'content'
}

function stableHashes(hashes: Readonly<Record<string, string>>): string {
  return Object.keys(hashes)
    .sort()
    .map((key) => `${key}=${hashes[key]}`)
    .join(',')
}

function changedInputs(
  previous: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>
): string[] {
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)])
  return [...keys].filter((key) => previous[key] !== current[key]).sort()
}

export function canReuseGateReceipt(args: {
  receipt: GateReceipt | undefined
  current: GateInputs
  riskPolicy?: GateRiskPolicy
}): GateReuseVerdict {
  if ((args.riskPolicy ?? 'standard') === 'high_risk') {
    // Why unconditional: a high-risk change must re-prove the full gate set even
    // when every bound input looks untouched.
    return {
      reuse: false,
      code: 'high_risk_policy',
      reason: 'High-risk policy requires the full gate set to rerun.'
    }
  }
  const receipt = args.receipt
  if (!receipt) {
    return {
      reuse: false,
      code: 'no_receipt',
      reason: `No receipt recorded for gate ${args.current.gateId}.`
    }
  }
  if (receipt.result !== 'PASS') {
    return {
      reuse: false,
      code: 'receipt_failed',
      reason: `Gate ${args.current.gateId} last recorded FAIL.`
    }
  }
  if (shaBindingOf(args.current) === 'exact_head' && receipt.finalSha !== args.current.finalSha) {
    return {
      reuse: false,
      code: 'sha_changed',
      reason: `Gate ${args.current.gateId} is bound to its exact head; receipt bound ${receipt.finalSha}, current SHA is ${args.current.finalSha}.`
    }
  }
  if (receipt.policyVersion !== args.current.policyVersion) {
    return {
      reuse: false,
      code: 'policy_version_changed',
      reason: `Receipt bound policy ${receipt.policyVersion}; current policy is ${args.current.policyVersion}.`
    }
  }
  if (receipt.commandIdentity !== args.current.commandIdentity) {
    return {
      reuse: false,
      code: 'command_changed',
      reason: `Receipt bound command ${receipt.commandIdentity}; current command is ${args.current.commandIdentity}.`
    }
  }
  // Why before the diff: an unreadable dependency compares equal to another
  // unreadable one, so a gate whose inputs cannot be read would otherwise
  // reuse a receipt on the strength of two unknowns matching.
  const unprovable = hasUnprovableDependency(args.current.inputHashes)
  if (unprovable) {
    return {
      reuse: false,
      code: 'dependency_unreadable',
      reason: `Gate ${args.current.gateId} declares ${unprovable}, which the runtime could not read, so its receipt cannot be proven current.`
    }
  }
  const changed = changedInputs(receipt.inputHashes, args.current.inputHashes)
  if (changed.length > 0) {
    return {
      reuse: false,
      code: 'inputs_changed',
      reason: `Inputs changed since the receipt: ${changed.join(', ')}.`
    }
  }
  return { reuse: true, receipt }
}

function toReceipt(row: GateReceiptRow): GateReceipt {
  return {
    gateId: row.gate_id,
    finalSha: row.final_sha,
    inputHashes: JSON.parse(row.input_hashes) as Record<string, string>,
    policyVersion: row.policy_version,
    commandIdentity: row.command_identity,
    result: row.result,
    recordedAt: row.recorded_at
  }
}

export function recordGateReceipt(
  store: ControlPlaneStore,
  args: { scopeKey: string; inputs: GateInputs; result: 'PASS' | 'FAIL'; recordedAt: string }
): GateReceipt {
  store.putGateReceipt({
    receipt_id: gateReceiptId(args.inputs),
    scope_key: args.scopeKey,
    gate_id: args.inputs.gateId,
    final_sha: args.inputs.finalSha,
    input_hashes: JSON.stringify(args.inputs.inputHashes),
    policy_version: args.inputs.policyVersion,
    command_identity: args.inputs.commandIdentity,
    result: args.result,
    recorded_at: args.recordedAt
  })
  return { ...args.inputs, result: args.result, recordedAt: args.recordedAt }
}

export function findGateReceipt(
  store: ControlPlaneStore,
  scopeKey: string,
  gateId: string
): GateReceipt | undefined {
  const row = store.listGateReceipts(scopeKey).find((entry) => entry.gate_id === gateId)
  return row ? toReceipt(row) : undefined
}

export type GateSetPlan = {
  reuse: { gateId: string; receipt: GateReceipt }[]
  rerun: { gateId: string; reason: string }[]
}

/** Plans an incremental gate set: reuse what the receipts still prove, rerun
 *  everything they do not. `log`-worthy by construction — nothing is dropped. */
export function planGateSet(args: {
  store: ControlPlaneStore
  scopeKey: string
  gates: readonly GateInputs[]
  riskPolicy?: GateRiskPolicy
}): GateSetPlan {
  const plan: GateSetPlan = { reuse: [], rerun: [] }
  for (const gate of args.gates) {
    const verdict = canReuseGateReceipt({
      receipt: findGateReceipt(args.store, args.scopeKey, gate.gateId),
      current: gate,
      riskPolicy: args.riskPolicy
    })
    if (verdict.reuse) {
      plan.reuse.push({ gateId: gate.gateId, receipt: verdict.receipt })
    } else {
      plan.rerun.push({ gateId: gate.gateId, reason: verdict.reason })
    }
  }
  return plan
}
