import { createHash } from 'node:crypto'

export type JsonObject = Record<string, unknown>
export type Digest = `sha256:${string}`

export const AUTHORIZED_MANIFEST_DIGEST: Digest =
  'sha256:f77f89ba3a9b7c0aef06850f58ef0eb2d2e1dca3e9ab7b609f1c6b7575468932'
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const PRODUCER_KEYS = [
  'change',
  'control_runtime_directory_digest',
  'control_runtime_reference_digest',
  'journal_digest',
  'run_id',
  'state_digest',
  'workspace_scope'
]
const WORKSPACE_KEYS = [
  'base_revision',
  'binding_receipt_hash',
  'binding_receipt_ref',
  'canonical_root',
  'coordinator_generation',
  'dirty_paths',
  'execution_host',
  'execution_workspace',
  'orchestration_home',
  'repository_id',
  'run_id',
  'schema_version'
]
const LOCATION_KEYS = ['execution_host_id', 'kind', 'path', 'workspace_key']
const CHECK_KEYS = ['authority', 'command', 'evidence', 'execution']
const EXECUTION_KEYS = ['command_digest', 'execution_id', 'source_snapshot_digest']
const IMPORT_KEYS = ['evidence', 'import_id']
const NESTED_PRODUCER_KEYS = ['check', 'evidence', 'grade', 'import', 'task_id']
const ROUTING_POLICY_KEYS = ['digest', 'evidence', 'path', 'policy_id']
export const REQUIRED_PRODUCER_TASKS: Record<string, readonly string[]> = {
  'MLK-06Q': ['MLK-06Q', 'MLK-06QR', 'MLK-15'],
  'MLK-07P': ['MLK-07', 'MLK-07P', 'MLK-19']
}

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
export const hasExactKeys = (value: JsonObject, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
export const isDigest = (value: unknown): value is Digest =>
  typeof value === 'string' && DIGEST_PATTERN.test(value)
export const digest = (bytes: Buffer): Digest =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`
export const same = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right)
export const asObject = (value: unknown): JsonObject | null => (isObject(value) ? value : null)

export function producerReceipt(producer: JsonObject): JsonObject {
  return {
    change: producer.change,
    control_runtime: {
      directory_digest: producer.control_runtime_directory_digest,
      reference_digest: producer.control_runtime_reference_digest,
      source_revision: asObject(producer.workspace_scope)?.base_revision
    },
    journal_digest: producer.journal_digest,
    run_id: producer.run_id,
    state_digest: producer.state_digest,
    workspace_scope: producer.workspace_scope
  }
}

function validateWorkspaceScope(value: unknown): boolean {
  if (!isObject(value) || !hasExactKeys(value, WORKSPACE_KEYS)) {
    return false
  }
  if (
    typeof value.base_revision !== 'string' ||
    !isDigest(value.binding_receipt_hash) ||
    typeof value.binding_receipt_ref !== 'string' ||
    typeof value.canonical_root !== 'string' ||
    !Number.isInteger(value.coordinator_generation) ||
    !Array.isArray(value.dirty_paths) ||
    value.dirty_paths.some((path) => typeof path !== 'string') ||
    typeof value.repository_id !== 'string' ||
    typeof value.run_id !== 'string' ||
    value.schema_version !== 1
  ) {
    return false
  }
  const host = asObject(value.execution_host)
  if (
    !host ||
    !hasExactKeys(host, ['boundary', 'id']) ||
    typeof host.boundary !== 'string' ||
    typeof host.id !== 'string'
  ) {
    return false
  }
  for (const location of [value.execution_workspace, value.orchestration_home]) {
    if (
      !isObject(location) ||
      !hasExactKeys(location, LOCATION_KEYS) ||
      typeof location.execution_host_id !== 'string' ||
      typeof location.kind !== 'string' ||
      typeof location.path !== 'string' ||
      typeof location.workspace_key !== 'string'
    ) {
      return false
    }
  }
  const workspace = asObject(value.execution_workspace)
  const orchestrationHome = asObject(value.orchestration_home)
  return (
    host.boundary === 'local' &&
    host.id === 'local' &&
    same(workspace, orchestrationHome) &&
    workspace?.execution_host_id === host.id
  )
}

export function validateProducer(value: unknown): value is JsonObject {
  if (!isObject(value) || !hasExactKeys(value, PRODUCER_KEYS)) {
    return false
  }
  return (
    value.change === 'maestro-harness-orchestration' &&
    typeof value.run_id === 'string' &&
    isDigest(value.control_runtime_directory_digest) &&
    isDigest(value.control_runtime_reference_digest) &&
    isDigest(value.journal_digest) &&
    isDigest(value.state_digest) &&
    validateWorkspaceScope(value.workspace_scope) &&
    asObject(value.workspace_scope)?.run_id === value.run_id
  )
}

function validateEvidence(value: unknown): boolean {
  return (
    isObject(value) &&
    hasExactKeys(value, ['digest', 'ref']) &&
    isDigest(value.digest) &&
    typeof value.ref === 'string' &&
    value.ref.startsWith('file:') &&
    value.ref.length > 5
  )
}

export function validateCheck(value: unknown): value is JsonObject {
  if (
    !isObject(value) ||
    !hasExactKeys(value, CHECK_KEYS) ||
    typeof value.command !== 'string' ||
    !validateEvidence(value.evidence)
  ) {
    return false
  }
  const execution = asObject(value.execution)
  return (
    (value.authority === 'checked_import' || value.authority === 'check_recorded') &&
    execution !== null &&
    hasExactKeys(execution, EXECUTION_KEYS) &&
    isDigest(execution.command_digest) &&
    typeof execution.execution_id === 'string' &&
    isDigest(execution.source_snapshot_digest)
  )
}

export function validateImportedEvidence(value: JsonObject): boolean {
  const receiptEvidence = value.evidence
  const check = asObject(value.check)
  const imported = asObject(value.import)
  return (
    check !== null &&
    imported !== null &&
    check.authority === 'checked_import' &&
    hasExactKeys(imported, IMPORT_KEYS) &&
    typeof imported.import_id === 'string' &&
    validateEvidence(imported.evidence) &&
    Array.isArray(receiptEvidence) &&
    receiptEvidence.length === 1 &&
    validateEvidence(receiptEvidence[0]) &&
    same(receiptEvidence[0], check.evidence) &&
    same(receiptEvidence[0], imported.evidence)
  )
}

function validateNestedProducer(value: unknown, taskId: string): value is JsonObject {
  if (
    !isObject(value) ||
    !hasExactKeys(value, NESTED_PRODUCER_KEYS) ||
    value.task_id !== taskId ||
    value.grade !== 'pass' ||
    !validateCheck(value.check)
  ) {
    return false
  }
  return validateImportedEvidence(value)
}

export function validateRequiredProducers(value: unknown, taskId: string): boolean {
  const expectedTaskIds = REQUIRED_PRODUCER_TASKS[taskId]
  if (!expectedTaskIds || !Array.isArray(value) || value.length !== expectedTaskIds.length) {
    return false
  }
  const identities = new Set<string>()
  for (const producer of value) {
    if (
      !isObject(producer) ||
      typeof producer.task_id !== 'string' ||
      identities.has(producer.task_id) ||
      !expectedTaskIds.includes(producer.task_id) ||
      !validateNestedProducer(producer, producer.task_id)
    ) {
      return false
    }
    identities.add(producer.task_id)
  }
  return expectedTaskIds.every((expectedTaskId) => identities.has(expectedTaskId))
}

export function validateRoutingPolicy(value: unknown, receiptEvidence: unknown): boolean {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ROUTING_POLICY_KEYS) ||
    !isDigest(value.digest) ||
    !validateEvidence(value.evidence) ||
    typeof value.path !== 'string' ||
    typeof value.policy_id !== 'string'
  ) {
    return false
  }
  return (
    Array.isArray(receiptEvidence) &&
    receiptEvidence.length === 1 &&
    same(receiptEvidence[0], value.evidence)
  )
}
