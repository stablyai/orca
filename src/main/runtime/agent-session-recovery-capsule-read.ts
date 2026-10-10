import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import { parseState, type RecoveryCapsuleState } from './agent-session-recovery-capsule-entries'

export const MAX_RECOVERY_CAPSULE_BYTES = 4 * 1024 * 1024

/** The capsule as stored; a missing file is an empty one. Callers hold the file's lock. */
export async function readRecoveryCapsuleState(filePath: string): Promise<RecoveryCapsuleState> {
  let raw: string
  try {
    raw = (await readNodeFileWithinLimit(filePath, MAX_RECOVERY_CAPSULE_BYTES)).buffer.toString(
      'utf8'
    )
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { entries: [], failed: [] }
    }
    throw error
  }
  return parseState(raw)
}
