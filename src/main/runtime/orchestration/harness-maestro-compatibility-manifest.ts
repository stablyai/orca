import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import {
  AUTHORIZED_MANIFEST_DIGEST,
  digest,
  hasExactKeys,
  isDigest,
  isObject,
  validateProducer,
  type JsonObject
} from './harness-maestro-compatibility-values'
import {
  validateReceipt,
  validateRequiredProducerLinks
} from './harness-maestro-compatibility-receipts'

export { AUTHORIZED_MANIFEST_DIGEST } from './harness-maestro-compatibility-values'

export const REQUIRED_CAPABILITIES = [
  ['workspace-binding', 'MLK-05'],
  ['selected-placement-recovery', 'MLK-05R'],
  ['typed-cleanup-lifecycle', 'MLK-06R'],
  ['persisted-driver-context', 'MLK-06D'],
  ['result-quarantine', 'MLK-06Q'],
  ['maestro-bridge', 'MLK-07'],
  ['run-progress', 'MLK-07P'],
  ['routing-policy', 'MLK-20']
] as const

export type CompatibilityVerification =
  | { accepted: true; manifestDigest: string }
  | { accepted: false; errors: string[] }

function isContainedReceiptPath(
  manifestPath: string,
  receiptPath: unknown,
  taskId: string
): string | null {
  if (
    typeof receiptPath !== 'string' ||
    isAbsolute(receiptPath) ||
    receiptPath !== `receipts/${taskId}.json`
  ) {
    return null
  }
  const manifestDirectory = dirname(manifestPath)
  const candidate = resolve(manifestDirectory, receiptPath)
  const relativePath = relative(manifestDirectory, candidate)
  if (
    !relativePath ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === '..' ||
    isAbsolute(relativePath)
  ) {
    return null
  }
  try {
    const manifestDirectoryReal = realpathSync(manifestDirectory)
    const candidateReal = realpathSync(candidate)
    const candidateRelative = relative(manifestDirectoryReal, candidateReal)
    if (
      candidateRelative.startsWith(`..${sep}`) ||
      candidateRelative === '..' ||
      isAbsolute(candidateRelative)
    ) {
      return null
    }
    if (lstatSync(candidate).isSymbolicLink() || !lstatSync(candidate).isFile()) {
      return null
    }
    return candidate
  } catch {
    return null
  }
}

export function verifyHarnessMaestroCompatibilityManifest(
  manifestPath: string
): CompatibilityVerification {
  const errors: string[] = []
  const absolute = resolve(manifestPath)
  try {
    if (
      lstatSync(absolute).isSymbolicLink() ||
      lstatSync(dirname(absolute)).isSymbolicLink() ||
      realpathSync(absolute) !== absolute ||
      realpathSync(dirname(absolute)) !== dirname(absolute)
    ) {
      return { accepted: false, errors: ['manifest or bundle path is symlinked'] }
    }
  } catch {
    return { accepted: false, errors: ['manifest or bundle path is unavailable'] }
  }
  let manifestBytes: Buffer
  let manifest: JsonObject
  try {
    manifestBytes = readFileSync(absolute)
    const parsed: unknown = JSON.parse(manifestBytes.toString('utf8'))
    if (!isObject(parsed)) {
      return { accepted: false, errors: ['manifest is not a JSON object'] }
    }
    manifest = parsed
  } catch {
    return { accepted: false, errors: ['manifest is not readable JSON'] }
  }
  const manifestDigest = digest(manifestBytes)
  if (
    manifestDigest !== AUTHORIZED_MANIFEST_DIGEST ||
    basename(dirname(absolute)) !== AUTHORIZED_MANIFEST_DIGEST.slice(7)
  ) {
    errors.push('manifest is not the authorized content-addressed bundle')
  }
  if (
    !hasExactKeys(manifest, ['producer', 'receipts', 'required_capabilities', 'schema_version']) ||
    manifest.schema_version !== 1
  ) {
    errors.push('unsupported or open manifest schema')
  }
  const producer = manifest.producer
  if (!validateProducer(producer)) {
    errors.push('invalid producer identity or workspace binding')
  }
  const required = manifest.required_capabilities
  const listed = manifest.receipts
  const requiredEntries: unknown[] = Array.isArray(required) ? required : []
  const listedEntries: unknown[] = Array.isArray(listed) ? listed : []
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
  const expected = new Map<string, string>(
    REQUIRED_CAPABILITIES.map(([name, task]) => [task, name])
  )
  const identities = new Set<string>()
  const parsedReceipts = new Map<string, JsonObject>()
  for (const entry of listedEntries) {
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
    const receiptPath = isContainedReceiptPath(absolute, entry.path, entry.task_id)
    if (!receiptPath) {
      errors.push(`receipt path escapes bundle for ${entry.task_id}`)
      continue
    }
    try {
      const bytes = readFileSync(receiptPath)
      if (digest(bytes) !== entry.digest) {
        errors.push(`receipt bytes changed for ${entry.task_id}`)
      }
      const receipt: unknown = JSON.parse(bytes.toString('utf8'))
      if (!validateReceipt(receipt, entry, validateProducer(producer) ? producer : {})) {
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
    const matches = requiredEntries.filter(
      (entry): entry is JsonObject => isObject(entry) && entry.task_id === task
    )
    if (matches.length !== 1 || matches[0].name !== name || matches[0].version !== 1) {
      errors.push(`required capability mismatch for ${task}`)
    }
  }
  if (!validateRequiredProducerLinks(parsedReceipts)) {
    errors.push('required producer evidence is incomplete or mismatched')
  }
  return errors.length ? { accepted: false, errors } : { accepted: true, manifestDigest }
}
