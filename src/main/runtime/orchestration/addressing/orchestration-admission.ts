/** Only semantic stages construct refusals; reader exceptions keep their acquisition provenance. */
export type OrchestrationAdmission<T> =
  | { kind: 'admitted'; value: T }
  | { kind: 'refused'; error: Error }

export function requireOrchestrationAdmission<T>(result: OrchestrationAdmission<T>): T {
  if (result.kind === 'refused') {
    throw result.error
  }
  return result.value
}
