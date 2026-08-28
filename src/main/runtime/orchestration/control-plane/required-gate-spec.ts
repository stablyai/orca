import { createHash } from 'node:crypto'
import type { RequiredGateSpecRow } from './control-plane-store'

/** The coordinator/DCS-owned meaning of a required gate. It is admitted with
 * the outcome manifest, before any builder has a capability for the Run. */
export type RequiredGateDefinition = {
  gateId: string
  program: string
  args: readonly string[]
  dependencies: readonly string[]
  policyVersion: string
  commandIdentity: string
  shaBinding: 'content' | 'exact_head'
}

function stable(values: readonly string[]): string[] {
  return [...values]
}

export function requiredGateSpecHash(spec: RequiredGateDefinition): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        gateId: spec.gateId,
        program: spec.program,
        args: stable(spec.args),
        dependencies: [...new Set(spec.dependencies)].sort(),
        policyVersion: spec.policyVersion,
        commandIdentity: spec.commandIdentity,
        shaBinding: spec.shaBinding
      })
    )
    .digest('hex')
}

export function requiredGateSpecRow(
  outcomeId: string,
  spec: RequiredGateDefinition
): RequiredGateSpecRow {
  return {
    outcome_id: outcomeId,
    gate_id: spec.gateId,
    program: spec.program,
    args_json: JSON.stringify(spec.args),
    dependencies_json: JSON.stringify([...new Set(spec.dependencies)].sort()),
    policy_version: spec.policyVersion,
    command_identity: spec.commandIdentity,
    sha_binding: spec.shaBinding,
    spec_hash: requiredGateSpecHash(spec)
  }
}

export function requiredGateDefinition(row: RequiredGateSpecRow): RequiredGateDefinition {
  return {
    gateId: row.gate_id,
    program: row.program,
    args: JSON.parse(row.args_json) as string[],
    dependencies: JSON.parse(row.dependencies_json) as string[],
    policyVersion: row.policy_version,
    commandIdentity: row.command_identity,
    shaBinding: row.sha_binding
  }
}
