import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  rmSync,
  statSync
} from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { copyFileWithWindowsRetry, renameFileWithWindowsRetry } from './fs-utils'

export const CODEX_LEGACY_SESSION_MAX_DEPTH = 32
export const CODEX_LEGACY_SESSION_MAX_ENTRIES = 50_000
export const CODEX_LEGACY_SESSION_MAX_TOTAL_FILE_BYTES = 4 * 1024 * 1024 * 1024
export const CODEX_LEGACY_SESSION_MAX_PATH_CODE_UNITS = 4 * 1024 * 1024
export const CODEX_LEGACY_SESSION_COMPARE_CHUNK_BYTES = 64 * 1024

export type CodexLegacySessionMigrationLimits = {
  maxDepth: number
  maxEntries: number
  maxTotalFileBytes: number
  maxPathCodeUnits: number
}

export const DEFAULT_CODEX_LEGACY_SESSION_MIGRATION_LIMITS: CodexLegacySessionMigrationLimits = {
  maxDepth: CODEX_LEGACY_SESSION_MAX_DEPTH,
  maxEntries: CODEX_LEGACY_SESSION_MAX_ENTRIES,
  maxTotalFileBytes: CODEX_LEGACY_SESSION_MAX_TOTAL_FILE_BYTES,
  maxPathCodeUnits: CODEX_LEGACY_SESSION_MAX_PATH_CODE_UNITS
}

export type CodexLegacySessionSkipReason =
  | 'depth'
  | 'entries'
  | 'total-file-bytes'
  | 'path-code-units'

export type CodexLegacySessionMigrationResult =
  | {
      kind: 'migrated'
      conflictCount: number
      copiedFileCount: number
      discoveredEntryCount: number
      discoveredFileBytes: number
      discoveredFileCount: number
    }
  | {
      kind: 'skipped'
      reason: CodexLegacySessionSkipReason
      observed: number
      limit: number
      visitedEntryCount: number
    }

type TraversalResult =
  | {
      kind: 'complete'
      entryCount: number
      fileBytes: number
      filePaths: string[]
    }
  | {
      kind: 'skipped'
      reason: CodexLegacySessionSkipReason
      observed: number
      limit: number
      visitedEntryCount: number
    }

class CodexLegacySessionCapacityError extends Error {
  constructor(
    readonly reason: CodexLegacySessionSkipReason,
    readonly observed: number,
    readonly limit: number,
    readonly visitedEntryCount: number
  ) {
    super(`Codex legacy sessions exceeded ${reason} limit (${observed} > ${limit})`)
    this.name = 'CodexLegacySessionCapacityError'
  }
}

export function migrateCodexLegacySessionsSync(options: {
  accountId: string
  legacySessionsRoot: string
  runtimeSessionsRoot: string
  limits?: Partial<CodexLegacySessionMigrationLimits>
  onConflict?: (conflict: { runtimeFilePath: string; preservedPath: string }) => void
}): CodexLegacySessionMigrationResult {
  const limits = resolveLimits(options.limits)
  const traversal = collectLegacySessionFilesSync(options.legacySessionsRoot, limits)
  if (traversal.kind === 'skipped') {
    return traversal
  }

  mkdirSync(options.runtimeSessionsRoot, { recursive: true })
  let conflictCount = 0
  let copiedFileCount = 0
  for (const legacyFilePath of traversal.filePaths) {
    const relativePath = relative(options.legacySessionsRoot, legacyFilePath)
    const runtimeFilePath = join(options.runtimeSessionsRoot, relativePath)
    mkdirSync(dirname(runtimeFilePath), { recursive: true })
    if (!existsSync(runtimeFilePath)) {
      copyFileAtomicallySync(legacyFilePath, runtimeFilePath)
      copiedFileCount += 1
      continue
    }
    if (codexLegacySessionFilesEqualSync(legacyFilePath, runtimeFilePath)) {
      continue
    }

    const preservedPath = getPreservedLegacySessionPath(runtimeFilePath, options.accountId)
    copyFileAtomicallySync(legacyFilePath, preservedPath)
    conflictCount += 1
    copiedFileCount += 1
    options.onConflict?.({ runtimeFilePath, preservedPath })
  }

  return {
    kind: 'migrated',
    conflictCount,
    copiedFileCount,
    discoveredEntryCount: traversal.entryCount,
    discoveredFileBytes: traversal.fileBytes,
    discoveredFileCount: traversal.filePaths.length
  }
}

function collectLegacySessionFilesSync(
  rootPath: string,
  limits: CodexLegacySessionMigrationLimits
): TraversalResult {
  let entryCount = 0
  let fileBytes = 0
  let pathCodeUnits = rootPath.length
  const filePaths: string[] = []
  const rootStats = statSync(rootPath)
  if (rootStats.isFile()) {
    assertWithinCapacity('total-file-bytes', rootStats.size, limits.maxTotalFileBytes, 0)
    assertWithinCapacity('path-code-units', pathCodeUnits, limits.maxPathCodeUnits, 0)
    return { kind: 'complete', entryCount: 0, fileBytes: rootStats.size, filePaths: [rootPath] }
  }

  const pendingDirectories = [{ depth: 0, path: rootPath }]
  try {
    while (pendingDirectories.length > 0) {
      const current = pendingDirectories.pop()!
      const directory = opendirSync(current.path)
      try {
        while (true) {
          const entry = directory.readSync()
          if (entry === null) {
            break
          }
          entryCount += 1
          assertWithinCapacity('entries', entryCount, limits.maxEntries, entryCount)
          const childPath = join(current.path, entry.name)
          pathCodeUnits += childPath.length
          assertWithinCapacity(
            'path-code-units',
            pathCodeUnits,
            limits.maxPathCodeUnits,
            entryCount
          )

          if (entry.isDirectory()) {
            const childDepth = current.depth + 1
            assertWithinCapacity('depth', childDepth, limits.maxDepth, entryCount)
            pendingDirectories.push({ depth: childDepth, path: childPath })
            continue
          }
          if (!entry.isFile()) {
            continue
          }

          const size = statSync(childPath).size
          fileBytes += size
          assertWithinCapacity('total-file-bytes', fileBytes, limits.maxTotalFileBytes, entryCount)
          filePaths.push(childPath)
        }
      } finally {
        closeDirectoryIgnoringAlreadyClosed(directory)
      }
    }
  } catch (error) {
    if (error instanceof CodexLegacySessionCapacityError) {
      return {
        kind: 'skipped',
        reason: error.reason,
        observed: error.observed,
        limit: error.limit,
        visitedEntryCount: error.visitedEntryCount
      }
    }
    throw error
  }

  return { kind: 'complete', entryCount, fileBytes, filePaths: filePaths.sort() }
}

export function codexLegacySessionFilesEqualSync(leftPath: string, rightPath: string): boolean {
  let leftDescriptor: number | null = null
  let rightDescriptor: number | null = null
  try {
    leftDescriptor = openSync(leftPath, 'r')
    rightDescriptor = openSync(rightPath, 'r')
    if (fstatSync(leftDescriptor).size !== fstatSync(rightDescriptor).size) {
      return false
    }

    const leftBuffer = Buffer.allocUnsafe(CODEX_LEGACY_SESSION_COMPARE_CHUNK_BYTES)
    const rightBuffer = Buffer.allocUnsafe(CODEX_LEGACY_SESSION_COMPARE_CHUNK_BYTES)
    while (true) {
      const leftBytes = readFullChunkSync(leftDescriptor, leftBuffer)
      const rightBytes = readFullChunkSync(rightDescriptor, rightBuffer)
      if (leftBytes !== rightBytes) {
        return false
      }
      if (leftBytes === 0) {
        return true
      }
      if (!leftBuffer.subarray(0, leftBytes).equals(rightBuffer.subarray(0, rightBytes))) {
        return false
      }
    }
  } finally {
    closeIgnoringErrors(leftDescriptor)
    closeIgnoringErrors(rightDescriptor)
  }
}

function readFullChunkSync(descriptor: number, buffer: Buffer): number {
  let offset = 0
  while (offset < buffer.length) {
    const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, null)
    if (bytesRead === 0) {
      break
    }
    offset += bytesRead
  }
  return offset
}

function copyFileAtomicallySync(sourcePath: string, targetPath: string): void {
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.migration.tmp`
  try {
    copyFileWithWindowsRetry(sourcePath, temporaryPath)
    renameFileWithWindowsRetry(temporaryPath, targetPath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

function getPreservedLegacySessionPath(runtimeFilePath: string, accountId: string): string {
  const extension = extname(runtimeFilePath)
  const basename = runtimeFilePath.slice(0, runtimeFilePath.length - extension.length)
  return `${basename}.orca-legacy-${accountId}${extension}`
}

function assertWithinCapacity(
  reason: CodexLegacySessionSkipReason,
  observed: number,
  limit: number,
  visitedEntryCount: number
): void {
  if (!Number.isSafeInteger(observed) || observed > limit) {
    throw new CodexLegacySessionCapacityError(reason, observed, limit, visitedEntryCount)
  }
}

function resolveLimits(
  overrides: Partial<CodexLegacySessionMigrationLimits> | undefined
): CodexLegacySessionMigrationLimits {
  const limits = { ...DEFAULT_CODEX_LEGACY_SESSION_MIGRATION_LIMITS, ...overrides }
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
    // Preserve the comparison result or original read error.
  }
}

function closeDirectoryIgnoringAlreadyClosed(directory: ReturnType<typeof opendirSync>): void {
  try {
    directory.closeSync()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') {
      throw error
    }
  }
}
