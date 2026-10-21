import { createHash } from 'node:crypto'
import { escapeRegex } from '../../../shared/string-utils'

export type SecretSentinelSubstitution = {
  /** The `orca-secret-slot-<uuid>` placeholder standing in the serialized state. */
  sentinel: string
  /** What the on-disk payload gets: the ciphertext. */
  blob: string
  /** What the guard hash gets: a value stable across non-deterministic encryption. */
  hashValue: string
}

type SecretSubstitutionOutput<T extends string | Buffer> = {
  encode: (value: string) => T
  concat: (chunks: T[]) => T
}

const bufferOutput: SecretSubstitutionOutput<Buffer> = {
  encode: (value) => Buffer.from(value, 'utf8'),
  concat: (chunks) => Buffer.concat(chunks)
}

const textOutput: SecretSubstitutionOutput<string> = {
  encode: (value) => value,
  concat: (chunks) => chunks.join('')
}

/** One traversal keeps ciphertext and guard hashes aligned without copying once per secret. */
export function applySecretSentinelSubstitutions(
  serialized: string,
  substitutions: readonly SecretSentinelSubstitution[],
  degradedPrefix: string,
  output?: 'buffer'
): { payload: Buffer; stateHash: string }
export function applySecretSentinelSubstitutions(
  serialized: string,
  substitutions: readonly SecretSentinelSubstitution[],
  degradedPrefix: string,
  output: 'text'
): { payload: string; stateHash: string }
export function applySecretSentinelSubstitutions(
  serialized: string,
  substitutions: readonly SecretSentinelSubstitution[],
  degradedPrefix: string,
  output: 'buffer' | 'text' = 'buffer'
): { payload: Buffer | string; stateHash: string } {
  return output === 'text'
    ? substituteSentinels(serialized, substitutions, degradedPrefix, textOutput)
    : substituteSentinels(serialized, substitutions, degradedPrefix, bufferOutput)
}

function substituteSentinels<T extends string | Buffer>(
  serialized: string,
  substitutions: readonly SecretSentinelSubstitution[],
  degradedPrefix: string,
  output: SecretSubstitutionOutput<T>
): { payload: T; stateHash: string } {
  const hash = createHash('sha1').update(degradedPrefix)
  if (substitutions.length === 0) {
    const payload = output.encode(serialized)
    return { payload, stateHash: hash.update(payload).digest('hex') }
  }

  const replacementBySentinel = new Map<string, { blob: T; hashValue: T }>()
  const alternatives: string[] = []
  for (const { sentinel, blob, hashValue } of substitutions) {
    // Match escaped JSON contents, including quotes and backslashes inside a secret.
    const escapedSentinel = JSON.stringify(sentinel).slice(1, -1)
    if (replacementBySentinel.has(escapedSentinel)) {
      continue
    }
    alternatives.push(escapeRegex(escapedSentinel))
    replacementBySentinel.set(escapedSentinel, {
      blob: output.encode(JSON.stringify(blob).slice(1, -1)),
      hashValue: output.encode(JSON.stringify(hashValue).slice(1, -1))
    })
  }

  // Substitute every occurrence so a repeated sentinel cannot survive on disk.
  const pattern = new RegExp(alternatives.join('|'), 'g')
  const chunks: T[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(serialized)) !== null) {
    const replacement = replacementBySentinel.get(match[0])
    if (replacement === undefined) {
      throw new Error('Secret substitution matched an unregistered sentinel')
    }
    // The Buffer output reuses each literal's UTF-8 bytes for both the payload and hash.
    const literal = output.encode(serialized.slice(cursor, match.index))
    chunks.push(literal, replacement.blob)
    hash.update(literal)
    hash.update(replacement.hashValue)
    cursor = match.index + match[0].length
  }
  const tail = output.encode(serialized.slice(cursor))
  chunks.push(tail)
  hash.update(tail)

  return { payload: output.concat(chunks), stateHash: hash.digest('hex') }
}
