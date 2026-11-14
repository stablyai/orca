import { rm } from 'node:fs/promises'
import { readNodeFileWithinLimit } from '../../../../shared/file-content/node-bounded-file-reader'
import { stringifyJsonWithinByteLimit } from '../../../../shared/json-stream/node-bounded-json-stringify'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  renameDurable,
  writeTempFileDurable
} from '../../../filesystem/durable-file-write'
import {
  normalizeState,
  parseState,
  type RecoveryCapsuleState
} from './agent-session-recovery-capsule-entries'

const MAX_CAPSULE_BYTES = 4 * 1024 * 1024
const STALE_WRITE_TEMP_FILE_AGE_MS = 24 * 60 * 60 * 1000
type StoredRecords = Pick<RecoveryCapsuleState, 'entries' | 'failed'>

export async function readRecoveryCapsule(filePath: string): Promise<RecoveryCapsuleState> {
  let raw: string
  try {
    raw = (await readNodeFileWithinLimit(filePath, MAX_CAPSULE_BYTES)).buffer.toString('utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { entries: [], failed: [] }
    }
    throw error
  }
  return parseState(raw)
}

export async function publishRecoveryCapsule(
  filePath: string,
  records: StoredRecords,
  now: number,
  dismissedAt: number | undefined
): Promise<void> {
  const { entries, failed } = normalizeState(records, now)
  const { serialized } = stringifyJsonWithinByteLimit(
    {
      version: 2,
      entries,
      ...(dismissedAt === undefined ? {} : { dismissedAt }),
      ...(failed.length === 0 ? {} : { failed })
    },
    MAX_CAPSULE_BYTES
  )
  await removeStaleDurableWriteTempFiles(filePath, {
    minimumAgeMs: STALE_WRITE_TEMP_FILE_AGE_MS
  })
  const tempPath = durableWriteTempPath(filePath)
  try {
    await writeTempFileDurable(tempPath, serialized, 0o600)
    await renameDurable(tempPath, filePath)
  } finally {
    await rm(tempPath, { force: true }).catch(() => {})
  }
}
