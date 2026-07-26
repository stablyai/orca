import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeSync
} from 'node:fs'
import { dirname } from 'node:path'
import { renameFileWithWindowsRetry } from './fs-utils'

export const CODEX_LEGACY_HISTORY_FILE_MAX_BYTES = 32 * 1024 * 1024
export const CODEX_LEGACY_HISTORY_LINE_MAX_BYTES = 1024 * 1024
export const CODEX_LEGACY_HISTORY_INPUT_MAX_LINES = 200_000
export const CODEX_LEGACY_HISTORY_OUTPUT_MAX_BYTES = 32 * 1024 * 1024
export const CODEX_LEGACY_HISTORY_READ_CHUNK_BYTES = 64 * 1024

export type CodexLegacyHistoryMigrationLimits = {
  maxFileBytes: number
  maxLineBytes: number
  maxInputLines: number
  maxOutputBytes: number
}

export const DEFAULT_CODEX_LEGACY_HISTORY_MIGRATION_LIMITS: CodexLegacyHistoryMigrationLimits = {
  maxFileBytes: CODEX_LEGACY_HISTORY_FILE_MAX_BYTES,
  maxLineBytes: CODEX_LEGACY_HISTORY_LINE_MAX_BYTES,
  maxInputLines: CODEX_LEGACY_HISTORY_INPUT_MAX_LINES,
  maxOutputBytes: CODEX_LEGACY_HISTORY_OUTPUT_MAX_BYTES
}

export type CodexLegacyHistorySkipReason =
  | 'file-bytes'
  | 'line-bytes'
  | 'input-lines'
  | 'output-bytes'

export type CodexLegacyHistoryMigrationResult =
  | {
      kind: 'merged'
      addedLineCount: number
      outputBytes: number
      outputLineCount: number
    }
  | { kind: 'empty' }
  | {
      kind: 'skipped'
      reason: CodexLegacyHistorySkipReason
      observed: number
      limit: number
    }

class CodexLegacyHistoryCapacityError extends Error {
  constructor(
    readonly reason: CodexLegacyHistorySkipReason,
    readonly observed: number,
    readonly limit: number
  ) {
    super(`Codex legacy history exceeded ${reason} limit (${observed} > ${limit})`)
    this.name = 'CodexLegacyHistoryCapacityError'
  }
}

export function mergeCodexLegacyHistorySync(options: {
  legacyHistoryPath: string
  runtimeHistoryPath: string
  limits?: Partial<CodexLegacyHistoryMigrationLimits>
}): CodexLegacyHistoryMigrationResult {
  const limits = resolveLimits(options.limits)
  const temporaryPath = `${options.runtimeHistoryPath}.${process.pid}.${randomUUID()}.migration.tmp`
  let outputDescriptor: number | null = null

  try {
    mkdirSync(dirname(options.runtimeHistoryPath), { recursive: true })
    outputDescriptor = openSync(temporaryPath, 'wx')
    const seenLines = new Set<string>()
    let inputLineCount = 0
    let outputBytes = 0
    let addedLineCount = 0

    const retainLine = (line: string, fromLegacy: boolean): void => {
      inputLineCount += 1
      assertWithinCapacity('input-lines', inputLineCount, limits.maxInputLines)
      if (!line || seenLines.has(line)) {
        return
      }

      const encodedLine = Buffer.from(`${line}\n`, 'utf8')
      assertWithinCapacity('output-bytes', outputBytes + encodedLine.length, limits.maxOutputBytes)
      seenLines.add(line)
      writeAll(outputDescriptor!, encodedLine)
      outputBytes += encodedLine.length
      if (fromLegacy) {
        addedLineCount += 1
      }
    }

    if (existsSync(options.runtimeHistoryPath)) {
      readHistoryLinesSync(options.runtimeHistoryPath, limits, (line) => retainLine(line, false))
    }
    readHistoryLinesSync(options.legacyHistoryPath, limits, (line) => retainLine(line, true))

    closeSync(outputDescriptor)
    outputDescriptor = null
    if (seenLines.size === 0) {
      rmSync(temporaryPath, { force: true })
      return { kind: 'empty' }
    }

    renameFileWithWindowsRetry(temporaryPath, options.runtimeHistoryPath)
    return {
      kind: 'merged',
      addedLineCount,
      outputBytes,
      outputLineCount: seenLines.size
    }
  } catch (error) {
    closeIgnoringErrors(outputDescriptor)
    rmSync(temporaryPath, { force: true })
    if (error instanceof CodexLegacyHistoryCapacityError) {
      return {
        kind: 'skipped',
        reason: error.reason,
        observed: error.observed,
        limit: error.limit
      }
    }
    throw error
  }
}

function readHistoryLinesSync(
  filePath: string,
  limits: CodexLegacyHistoryMigrationLimits,
  onLine: (line: string) => void
): void {
  const descriptor = openSync(filePath, 'r')
  try {
    const initialBytes = fstatSync(descriptor).size
    assertWithinCapacity('file-bytes', initialBytes, limits.maxFileBytes)
    const readBuffer = Buffer.allocUnsafe(CODEX_LEGACY_HISTORY_READ_CHUNK_BYTES)
    let sourceBytes = 0
    let fragments: Buffer[] = []
    let fragmentBytes = 0

    while (true) {
      const bytesRead = readSync(descriptor, readBuffer, 0, readBuffer.length, null)
      if (bytesRead === 0) {
        break
      }
      sourceBytes += bytesRead
      assertWithinCapacity('file-bytes', sourceBytes, limits.maxFileBytes)

      let offset = 0
      while (offset < bytesRead) {
        const newlineIndex = readBuffer.indexOf(0x0a, offset)
        const end = newlineIndex === -1 || newlineIndex >= bytesRead ? bytesRead : newlineIndex
        const nextFragmentBytes = end - offset
        assertWithinCapacity('line-bytes', fragmentBytes + nextFragmentBytes, limits.maxLineBytes)
        if (nextFragmentBytes > 0) {
          fragments.push(Buffer.from(readBuffer.subarray(offset, end)))
          fragmentBytes += nextFragmentBytes
        }
        if (newlineIndex === -1 || newlineIndex >= bytesRead) {
          break
        }
        onLine(decodeLine(fragments, fragmentBytes))
        fragments = []
        fragmentBytes = 0
        offset = newlineIndex + 1
      }
    }

    if (fragmentBytes > 0) {
      onLine(decodeLine(fragments, fragmentBytes))
    }
  } finally {
    closeSync(descriptor)
  }
}

function decodeLine(fragments: Buffer[], bytes: number): string {
  if (fragments.length === 1) {
    return fragments[0]!.toString('utf8')
  }
  return Buffer.concat(fragments, bytes).toString('utf8')
}

function writeAll(descriptor: number, buffer: Buffer): void {
  let offset = 0
  while (offset < buffer.length) {
    offset += writeSync(descriptor, buffer, offset, buffer.length - offset)
  }
}

function assertWithinCapacity(
  reason: CodexLegacyHistorySkipReason,
  observed: number,
  limit: number
): void {
  if (observed > limit) {
    throw new CodexLegacyHistoryCapacityError(reason, observed, limit)
  }
}

function resolveLimits(
  overrides: Partial<CodexLegacyHistoryMigrationLimits> | undefined
): CodexLegacyHistoryMigrationLimits {
  const limits = { ...DEFAULT_CODEX_LEGACY_HISTORY_MIGRATION_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`)
    }
  }
  return limits
}

function closeIgnoringErrors(descriptor: number | null): void {
  if (descriptor === null) {
    return
  }
  try {
    closeSync(descriptor)
  } catch {
    // The original migration error is more actionable than cleanup failure.
  }
}
