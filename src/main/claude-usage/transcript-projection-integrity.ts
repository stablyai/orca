import { createHash } from 'node:crypto'
import type { ClaudeUsagePersistedFile } from './types'

const HASH_CHUNK_CHARACTERS = 16_384
export const CLAUDE_USAGE_VALIDATION_BATCH_ROWS = 1024

export function* iterateClaudeUsageProjectionIntegrity(
  file: ClaudeUsagePersistedFile
): Generator<void, string> {
  const state = file.parseResumeState
  if (!state) {
    throw new Error('Claude usage projection integrity requires a resume checkpoint.')
  }
  const hash = createHash('sha256')
  let pieces: string[] = []
  let characters = 0
  const flush = (): void => {
    if (pieces.length > 0) {
      hash.update(pieces.join(''))
      pieces = []
      characters = 0
    }
  }
  const append = (value: unknown): void => {
    const record = `${JSON.stringify(value)}\n`
    if (characters + record.length > HASH_CHUNK_CHARACTERS) {
      flush()
    }
    if (record.length >= HASH_CHUNK_CHARACTERS) {
      hash.update(record)
    } else {
      pieces.push(record)
      characters += record.length
    }
  }

  append([
    'claude-usage-projection-v1',
    file.path,
    file.mtimeMs,
    file.size,
    file.lineCount,
    file.physicalFileId ?? null,
    file.ctimeMs ?? null,
    file.hasDeferredClaims,
    state.parsedBytes,
    state.lineCount,
    state.boundaryDigest,
    state.headDigest,
    state.physicalFileId,
    file.ownedDedupeKeys.length,
    state.ownedTokenMaxima.length
  ])
  for (let index = 0; index < file.ownedDedupeKeys.length; index++) {
    append([file.ownedDedupeKeys[index], state.ownedTokenMaxima[index]])
    if ((index + 1) % CLAUDE_USAGE_VALIDATION_BATCH_ROWS === 0) {
      yield
    }
  }
  let checkedRecords = 0
  for (const records of [
    state.projections,
    state.encounterOrder,
    file.sessions,
    file.dailyAggregates
  ]) {
    append(records.length)
    for (const record of records) {
      append(record)
      if (++checkedRecords % CLAUDE_USAGE_VALIDATION_BATCH_ROWS === 0) {
        yield
      }
    }
  }
  flush()
  return hash.digest('hex')
}

export function buildClaudeUsageProjectionIntegrity(file: ClaudeUsagePersistedFile): string {
  const iterator = iterateClaudeUsageProjectionIntegrity(file)
  while (true) {
    const next = iterator.next()
    if (next.done) {
      return next.value
    }
  }
}
