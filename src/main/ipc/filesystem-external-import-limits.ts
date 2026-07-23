import {
  NATIVE_FILE_DROP_MAX_PATH_BYTES,
  NATIVE_FILE_DROP_MAX_PATHS
} from '../../shared/native-file-drop'

export const EXTERNAL_IMPORT_MAX_SOURCE_PATHS = NATIVE_FILE_DROP_MAX_PATHS
export const EXTERNAL_IMPORT_MAX_SOURCE_PATH_BYTES = NATIVE_FILE_DROP_MAX_PATH_BYTES
export const EXTERNAL_IMPORT_MAX_TREE_ENTRIES = 100_000
export const EXTERNAL_IMPORT_MAX_TREE_DEPTH = 256
export const EXTERNAL_IMPORT_MAX_RELATIVE_PATH_BYTES = 64 * 1024
export const REMOTE_IMPORT_MAX_RETAINED_PATH_BYTES = 16 * 1024 * 1024
export const REMOTE_IMPORT_MAX_FILE_BYTES = 25 * 1024 * 1024
export const REMOTE_IMPORT_MAX_TOTAL_BYTES = 100 * 1024 * 1024

export const EXTERNAL_IMPORT_TREE_ENTRY_LIMIT_MESSAGE =
  'External import tree exceeds 100,000 entries'
export const EXTERNAL_IMPORT_TREE_DEPTH_LIMIT_MESSAGE =
  'External import tree exceeds 256 nested directory levels'
export const EXTERNAL_IMPORT_RELATIVE_PATH_LIMIT_MESSAGE =
  'External import relative path exceeds 64 KiB'
export const REMOTE_IMPORT_RETAINED_PATH_LIMIT_MESSAGE =
  'Remote import retained paths exceed 16 MiB'

export type ExternalImportTreeBudget = {
  entries: number
  retainedPathBytes: number
}

export type RuntimeUploadRetentionBudget = {
  tree: ExternalImportTreeBudget
  fileBytes: number
}

export type RuntimeUploadRetentionCheckpoint = {
  entries: number
  retainedPathBytes: number
  fileBytes: number
}

export class ExternalImportCapacityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExternalImportCapacityError'
  }
}

export function assertExternalImportSourcePaths(
  sourcePaths: unknown
): asserts sourcePaths is readonly string[] {
  if (!Array.isArray(sourcePaths)) {
    throw new TypeError('External import source paths must be an array')
  }
  if (sourcePaths.length > EXTERNAL_IMPORT_MAX_SOURCE_PATHS) {
    throw new ExternalImportCapacityError(
      `External import accepts at most ${EXTERNAL_IMPORT_MAX_SOURCE_PATHS} source paths`
    )
  }

  let pathBytes = 0
  for (const sourcePath of sourcePaths) {
    if (typeof sourcePath !== 'string') {
      throw new TypeError('External import source paths must be strings')
    }
    pathBytes += Buffer.byteLength(sourcePath, 'utf8')
    if (pathBytes > EXTERNAL_IMPORT_MAX_SOURCE_PATH_BYTES) {
      throw new ExternalImportCapacityError('External import source paths exceed 256 KiB')
    }
  }
}

export function createExternalImportTreeBudget(): ExternalImportTreeBudget {
  return { entries: 0, retainedPathBytes: 0 }
}

export function assertExternalImportTreeDepth(depth: number): void {
  if (depth > EXTERNAL_IMPORT_MAX_TREE_DEPTH) {
    throw new ExternalImportCapacityError(EXTERNAL_IMPORT_TREE_DEPTH_LIMIT_MESSAGE)
  }
}

export function admitExternalImportTreeEntry(
  budget: ExternalImportTreeBudget,
  relativePath: string,
  retainPath: boolean
): void {
  if (budget.entries >= EXTERNAL_IMPORT_MAX_TREE_ENTRIES) {
    throw new ExternalImportCapacityError(EXTERNAL_IMPORT_TREE_ENTRY_LIMIT_MESSAGE)
  }

  const pathBytes = Buffer.byteLength(relativePath, 'utf8')
  if (pathBytes > EXTERNAL_IMPORT_MAX_RELATIVE_PATH_BYTES) {
    throw new ExternalImportCapacityError(EXTERNAL_IMPORT_RELATIVE_PATH_LIMIT_MESSAGE)
  }
  const retainedPathBytes = relativePath.length * 2
  if (
    retainPath &&
    retainedPathBytes > REMOTE_IMPORT_MAX_RETAINED_PATH_BYTES - budget.retainedPathBytes
  ) {
    throw new ExternalImportCapacityError(REMOTE_IMPORT_RETAINED_PATH_LIMIT_MESSAGE)
  }

  budget.entries += 1
  if (retainPath) {
    budget.retainedPathBytes += retainedPathBytes
  }
}

export function createRuntimeUploadRetentionBudget(): RuntimeUploadRetentionBudget {
  return {
    tree: createExternalImportTreeBudget(),
    fileBytes: 0
  }
}

export function captureRuntimeUploadRetentionCheckpoint(
  budget: RuntimeUploadRetentionBudget
): RuntimeUploadRetentionCheckpoint {
  return {
    entries: budget.tree.entries,
    retainedPathBytes: budget.tree.retainedPathBytes,
    fileBytes: budget.fileBytes
  }
}

export function restoreRuntimeUploadRetentionCheckpoint(
  budget: RuntimeUploadRetentionBudget,
  checkpoint: RuntimeUploadRetentionCheckpoint
): void {
  budget.tree.entries = checkpoint.entries
  budget.tree.retainedPathBytes = checkpoint.retainedPathBytes
  budget.fileBytes = checkpoint.fileBytes
}

export function assertRuntimeUploadFileFits(
  budget: RuntimeUploadRetentionBudget,
  relativePath: string,
  fileBytes: number
): void {
  if (!Number.isSafeInteger(fileBytes) || fileBytes < 0) {
    throw new Error(`Could not safely measure '${relativePath}' for remote import`)
  }
  if (fileBytes > REMOTE_IMPORT_MAX_FILE_BYTES) {
    throw new ExternalImportCapacityError(`'${relativePath}' is too large for remote import`)
  }
  if (fileBytes > REMOTE_IMPORT_MAX_TOTAL_BYTES - budget.fileBytes) {
    throw new ExternalImportCapacityError('Remote import is too large')
  }
}

export function retainRuntimeUploadFileBytes(
  budget: RuntimeUploadRetentionBudget,
  relativePath: string,
  fileBytes: number
): void {
  assertRuntimeUploadFileFits(budget, relativePath, fileBytes)
  budget.fileBytes += fileBytes
}
