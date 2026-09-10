import {
  REQUIRED_PRODUCER_TASKS,
  asObject,
  hasExactKeys,
  isObject,
  producerReceipt,
  same,
  validateCheck,
  validateImportedEvidence,
  validateRequiredProducers,
  validateRoutingPolicy,
  type JsonObject
} from './harness-maestro-compatibility-values'

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

function receiptKeysFor(taskId: string): readonly string[] {
  if (REQUIRED_PRODUCER_TASKS[taskId]) {
    return RECEIPT_KEYS_WITH_REQUIRED_PRODUCERS
  }
  if (taskId === 'MLK-20') {
    return RECEIPT_KEYS_WITH_ROUTING_POLICY
  }
  return RECEIPT_KEYS
}

export function validateReceipt(
  value: unknown,
  pin: JsonObject,
  producer: JsonObject
): value is JsonObject {
  if (
    !isObject(value) ||
    !hasExactKeys(value, receiptKeysFor(String(pin.task_id))) ||
    typeof value.task_id !== 'string' ||
    value.schema_version !== 1 ||
    value.task_id !== pin.task_id ||
    value.grade !== 'pass' ||
    !same(value.capability, pin.capability) ||
    !same(value.producer, producerReceipt(producer)) ||
    !validateCheck(value.check)
  ) {
    return false
  }
  if (
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
      validateRoutingPolicy(value.routing_policy, value.evidence)
    )
  }
  if (!validateImportedEvidence(value)) {
    return false
  }
  return (
    !REQUIRED_PRODUCER_TASKS[value.task_id] ||
    validateRequiredProducers(value.required_producers, value.task_id)
  )
}

export function validateRequiredProducerLinks(receipts: ReadonlyMap<string, JsonObject>): boolean {
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
