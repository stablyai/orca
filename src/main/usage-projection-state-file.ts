import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  JsonStringifyByteLimitError,
  stringifyJsonWithinByteLimit
} from '../shared/node-bounded-json-stringify'
import { readNodeFileSyncWithinLimit } from '../shared/node-bounded-file-reader'
import {
  assertJsonTextStructureWithinLimits,
  type JsonTextStructureLimits
} from '../shared/json-text-structure-limit'

export const MAX_USAGE_PROJECTION_STATE_FILE_BYTES = 64 * 1024 * 1024
export const USAGE_PROJECTION_STATE_JSON_LIMITS: JsonTextStructureLimits = {
  structuralTokens: 1_000_000,
  nestingDepth: 256
}

export class UsageProjectionStateCapacityError extends Error {
  constructor(readonly maxBytes = MAX_USAGE_PROJECTION_STATE_FILE_BYTES) {
    super(`Usage analytics cache exceeds ${maxBytes} bytes and must be rebuilt.`)
    this.name = 'UsageProjectionStateCapacityError'
  }
}

export function readUsageProjectionStateFile(
  filePath: string,
  maxBytes = MAX_USAGE_PROJECTION_STATE_FILE_BYTES,
  structureLimits: JsonTextStructureLimits = USAGE_PROJECTION_STATE_JSON_LIMITS
): string | null {
  try {
    const serialized = readNodeFileSyncWithinLimit(filePath, maxBytes).buffer.toString('utf8')
    assertJsonTextStructureWithinLimits(serialized, structureLimits)
    return serialized
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export function serializeUsageProjectionState(
  state: unknown,
  maxBytes = MAX_USAGE_PROJECTION_STATE_FILE_BYTES
): string {
  try {
    return stringifyJsonWithinByteLimit(state, maxBytes).serialized
  } catch (error) {
    if (error instanceof JsonStringifyByteLimitError) {
      throw new UsageProjectionStateCapacityError(maxBytes)
    }
    throw error
  }
}

export function writeUsageProjectionStateFile(
  filePath: string,
  state: unknown,
  maxBytes = MAX_USAGE_PROJECTION_STATE_FILE_BYTES
): void {
  const payload = serializeUsageProjectionState(state, maxBytes)
  mkdirSync(dirname(filePath), { recursive: true })
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  let renamed = false
  try {
    writeFileSync(tmpFile, payload, 'utf8')
    renameSync(tmpFile, filePath)
    renamed = true
  } finally {
    if (!renamed) {
      try {
        unlinkSync(tmpFile)
      } catch {
        // The primary write error is more useful than a best-effort cleanup failure.
      }
    }
  }
}

export function writeUsageProjectionStateFileWithRecovery<T>(
  filePath: string,
  state: T,
  recover: (error: UsageProjectionStateCapacityError) => T,
  maxBytes = MAX_USAGE_PROJECTION_STATE_FILE_BYTES
): T {
  try {
    writeUsageProjectionStateFile(filePath, state, maxBytes)
    return state
  } catch (error) {
    if (!(error instanceof UsageProjectionStateCapacityError)) {
      throw error
    }
    const recovered = recover(error)
    writeUsageProjectionStateFile(filePath, recovered, maxBytes)
    return recovered
  }
}
