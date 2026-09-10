import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const REQUIRED_CAPABILITIES = [
  ['workspace-binding', 'MLK-05'],
  ['selected-placement-recovery', 'MLK-05R'],
  ['typed-cleanup-lifecycle', 'MLK-06R'],
  ['persisted-driver-context', 'MLK-06D'],
  ['result-quarantine', 'MLK-06Q'],
  ['maestro-bridge', 'MLK-07'],
  ['run-progress', 'MLK-07P'],
  ['routing-policy', 'MLK-20']
]
const AUTHORIZED_MANIFEST_DIGEST =
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
const RECEIPT_KEYS = [
  'capability',
  'check',
  'evidence',
  'grade',
  'import',
  'producer',
  'schema_version',
  'task_id'
]
const RECEIPT_KEYS_WITH_REQUIRED_PRODUCERS = [...RECEIPT_KEYS, 'required_producers']
const RECEIPT_KEYS_WITH_ROUTING_POLICY = [...RECEIPT_KEYS, 'routing_policy']
const ROUTING_POLICY_KEYS = ['digest', 'evidence', 'path', 'policy_id']
const REQUIRED_PRODUCER_TASKS = {
  'MLK-06Q': ['MLK-06Q', 'MLK-06QR', 'MLK-15'],
  'MLK-07P': ['MLK-07', 'MLK-07P', 'MLK-19']
}
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const hasExactKeys = (value, keys) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const isDigest = (value) => typeof value === 'string' && DIGEST_PATTERN.test(value)
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const asObject = (value) => (isObject(value) ? value : null)
const producerReceipt = (producer) => ({
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
})

const containedReceiptPath = (manifestPath, receiptPath, taskId) => {
  if (
    typeof receiptPath !== 'string' ||
    isAbsolute(receiptPath) ||
    receiptPath !== `receipts/${taskId}.json`
  ) {
    return null
  }
  const directory = dirname(manifestPath)
  const candidate = resolve(directory, receiptPath)
  const lexical = relative(directory, candidate)
  if (!lexical || lexical.startsWith(`..${sep}`) || lexical === '..' || isAbsolute(lexical)) {
    return null
  }
  try {
    const realDirectory = realpathSync(directory)
    const realCandidate = realpathSync(candidate)
    const physical = relative(realDirectory, realCandidate)
    if (
      physical.startsWith(`..${sep}`) ||
      physical === '..' ||
      isAbsolute(physical) ||
      lstatSync(candidate).isSymbolicLink() ||
      !lstatSync(candidate).isFile()
    ) {
      return null
    }
    return candidate
  } catch {
    return null
  }
}

const validWorkspace = (value) => {
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
const validProducer = (value) =>
  isObject(value) &&
  hasExactKeys(value, PRODUCER_KEYS) &&
  value.change === 'maestro-harness-orchestration' &&
  typeof value.run_id === 'string' &&
  isDigest(value.control_runtime_directory_digest) &&
  isDigest(value.control_runtime_reference_digest) &&
  isDigest(value.journal_digest) &&
  isDigest(value.state_digest) &&
  validWorkspace(value.workspace_scope) &&
  asObject(value.workspace_scope)?.run_id === value.run_id
const validEvidence = (value) =>
  isObject(value) &&
  hasExactKeys(value, ['digest', 'ref']) &&
  isDigest(value.digest) &&
  typeof value.ref === 'string' &&
  value.ref.startsWith('file:') &&
  value.ref.length > 5
const validCheck = (value) => {
  if (
    !isObject(value) ||
    !hasExactKeys(value, CHECK_KEYS) ||
    typeof value.command !== 'string' ||
    !validEvidence(value.evidence)
  ) {
    return false
  }
  const execution = asObject(value.execution)
  return (
    (value.authority === 'checked_import' || value.authority === 'check_recorded') &&
    execution &&
    hasExactKeys(execution, EXECUTION_KEYS) &&
    isDigest(execution.command_digest) &&
    typeof execution.execution_id === 'string' &&
    isDigest(execution.source_snapshot_digest)
  )
}
const validImportedEvidence = (value) => {
  const check = asObject(value.check)
  const imported = asObject(value.import)
  const evidence = value.evidence
  return (
    check &&
    imported &&
    check.authority === 'checked_import' &&
    hasExactKeys(imported, IMPORT_KEYS) &&
    typeof imported.import_id === 'string' &&
    validEvidence(imported.evidence) &&
    Array.isArray(evidence) &&
    evidence.length === 1 &&
    validEvidence(evidence[0]) &&
    same(evidence[0], check.evidence) &&
    same(evidence[0], imported.evidence)
  )
}
const validNestedProducer = (value, taskId) =>
  isObject(value) &&
  hasExactKeys(value, NESTED_PRODUCER_KEYS) &&
  value.task_id === taskId &&
  value.grade === 'pass' &&
  validCheck(value.check) &&
  validImportedEvidence(value)
const validRequiredProducers = (value, taskId) => {
  const expectedTaskIds = REQUIRED_PRODUCER_TASKS[taskId]
  if (!expectedTaskIds || !Array.isArray(value) || value.length !== expectedTaskIds.length) {
    return false
  }
  const identities = new Set()
  for (const producer of value) {
    if (
      !isObject(producer) ||
      typeof producer.task_id !== 'string' ||
      identities.has(producer.task_id) ||
      !expectedTaskIds.includes(producer.task_id) ||
      !validNestedProducer(producer, producer.task_id)
    ) {
      return false
    }
    identities.add(producer.task_id)
  }
  return expectedTaskIds.every((taskId) => identities.has(taskId))
}
const validRoutingPolicy = (value, receiptEvidence) =>
  isObject(value) &&
  hasExactKeys(value, ROUTING_POLICY_KEYS) &&
  isDigest(value.digest) &&
  validEvidence(value.evidence) &&
  typeof value.path === 'string' &&
  typeof value.policy_id === 'string' &&
  Array.isArray(receiptEvidence) &&
  receiptEvidence.length === 1 &&
  same(receiptEvidence[0], value.evidence)
const receiptKeysFor = (taskId) =>
  REQUIRED_PRODUCER_TASKS[taskId]
    ? RECEIPT_KEYS_WITH_REQUIRED_PRODUCERS
    : taskId === 'MLK-20'
      ? RECEIPT_KEYS_WITH_ROUTING_POLICY
      : RECEIPT_KEYS
const validReceipt = (value, pin, producer) => {
  if (
    !isObject(value) ||
    !hasExactKeys(value, receiptKeysFor(String(pin.task_id))) ||
    value.schema_version !== 1 ||
    value.task_id !== pin.task_id ||
    value.grade !== 'pass' ||
    !same(value.capability, pin.capability) ||
    !same(value.producer, producerReceipt(producer)) ||
    !validCheck(value.check) ||
    !isObject(value.capability) ||
    !hasExactKeys(value.capability, ['name', 'version']) ||
    typeof value.capability.name !== 'string' ||
    value.capability.version !== 1
  ) {
    return false
  }
  if (value.task_id === 'MLK-20') {
    return (
      value.import === null &&
      asObject(value.check)?.authority === 'check_recorded' &&
      validRoutingPolicy(value.routing_policy, value.evidence)
    )
  }
  return (
    validImportedEvidence(value) &&
    (!REQUIRED_PRODUCER_TASKS[value.task_id] ||
      validRequiredProducers(value.required_producers, value.task_id))
  )
}
const validRequiredProducerLinks = (receipts) => {
  for (const taskId of ['MLK-06Q', 'MLK-07P']) {
    const receipt = receipts.get(taskId)
    const requiredProducers = asObject(receipt)?.required_producers
    if (!Array.isArray(requiredProducers)) {
      return false
    }
    for (const producer of requiredProducers) {
      if (!isObject(producer)) {
        return false
      }
      const matchingReceipt = receipts.get(String(producer.task_id))
      if (matchingReceipt && !same(producer.check, matchingReceipt.check)) {
        return false
      }
    }
  }
  return true
}
const fail = (message) => {
  console.error(`REJECTED: ${message}`)
  process.exitCode = 1
}
const argumentsList = process.argv.slice(2)
const file = argumentsList[1]
if (argumentsList.length !== 2 || argumentsList[0] !== '--manifest' || !file) {
  fail('usage: node ... --manifest <manifest>')
} else {
  try {
    const manifestPath = resolve(file)
    if (
      lstatSync(manifestPath).isSymbolicLink() ||
      lstatSync(dirname(manifestPath)).isSymbolicLink() ||
      realpathSync(manifestPath) !== manifestPath ||
      realpathSync(dirname(manifestPath)) !== dirname(manifestPath)
    ) {
      throw new Error('manifest or bundle path is symlinked')
    }
    const bytes = readFileSync(manifestPath)
    const manifest = JSON.parse(bytes.toString('utf8'))
    if (!isObject(manifest)) {
      throw new Error('manifest is not a JSON object')
    }
    const errors = []
    const actual = digest(bytes)
    const producer = manifest.producer
    if (
      actual !== AUTHORIZED_MANIFEST_DIGEST ||
      basename(dirname(manifestPath)) !== AUTHORIZED_MANIFEST_DIGEST.slice(7)
    ) {
      errors.push('manifest is not the authorized content-addressed bundle')
    }
    if (
      !hasExactKeys(manifest, [
        'producer',
        'receipts',
        'required_capabilities',
        'schema_version'
      ]) ||
      manifest.schema_version !== 1
    ) {
      errors.push('unsupported or open manifest schema')
    }
    if (!validProducer(producer)) {
      errors.push('invalid producer identity or workspace binding')
    }
    const required = manifest.required_capabilities
    const listed = manifest.receipts
    if (
      !Array.isArray(required) ||
      required.length !== REQUIRED_CAPABILITIES.length ||
      required.some(
        (entry) =>
          !isObject(entry) ||
          !hasExactKeys(entry, ['name', 'task_id', 'version']) ||
          typeof entry.name !== 'string' ||
          typeof entry.task_id !== 'string' ||
          entry.version !== 1
      )
    ) {
      errors.push('incomplete or open capability set')
    }
    if (!Array.isArray(listed) || listed.length !== REQUIRED_CAPABILITIES.length) {
      errors.push('incomplete receipt set')
    }
    const expected = new Map(REQUIRED_CAPABILITIES.map(([name, task]) => [task, name]))
    const identities = new Set()
    const parsedReceipts = new Map()
    for (const entry of listed ?? []) {
      if (
        !isObject(entry) ||
        !hasExactKeys(entry, ['capability', 'digest', 'path', 'task_id']) ||
        typeof entry.task_id !== 'string' ||
        identities.has(entry.task_id)
      ) {
        errors.push('duplicate or invalid receipt identity')
        continue
      }
      identities.add(entry.task_id)
      if (
        !isObject(entry.capability) ||
        !hasExactKeys(entry.capability, ['name', 'version']) ||
        expected.get(entry.task_id) !== entry.capability.name ||
        entry.capability.version !== 1
      ) {
        errors.push(`unsupported capability for ${entry.task_id}`)
      }
      if (!isDigest(entry.digest)) {
        errors.push(`invalid receipt digest for ${entry.task_id}`)
        continue
      }
      const receiptPath = containedReceiptPath(manifestPath, entry.path, entry.task_id)
      if (!receiptPath) {
        errors.push(`receipt path escapes bundle for ${entry.task_id}`)
        continue
      }
      try {
        const receiptBytes = readFileSync(receiptPath)
        if (digest(receiptBytes) !== entry.digest) {
          errors.push(`receipt bytes changed for ${entry.task_id}`)
        }
        const receipt = JSON.parse(receiptBytes.toString('utf8'))
        if (!validReceipt(receipt, entry, validProducer(producer) ? producer : {})) {
          errors.push(`invalid producer receipt for ${entry.task_id}`)
        } else {
          parsedReceipts.set(entry.task_id, receipt)
        }
      } catch {
        errors.push(`missing or invalid receipt for ${entry.task_id}`)
      }
    }
    for (const [name, task] of REQUIRED_CAPABILITIES) {
      if (!identities.has(task)) {
        errors.push(`missing required receipt ${task}`)
      }
      const matches = (required ?? []).filter((entry) => isObject(entry) && entry.task_id === task)
      if (matches.length !== 1 || matches[0].name !== name || matches[0].version !== 1) {
        errors.push(`required capability mismatch for ${task}`)
      }
    }
    if (!validRequiredProducerLinks(parsedReceipts)) {
      errors.push('required producer evidence is incomplete or mismatched')
    }
    if (errors.length) {
      fail(errors.join('; '))
    } else {
      console.log(JSON.stringify({ accepted: true, manifestDigest: actual }))
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : 'invalid manifest')
  }
}
