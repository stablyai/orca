import { describe, expect, it } from 'vitest'
import {
  admitExternalImportTreeEntry,
  assertExternalImportSourcePaths,
  assertExternalImportTreeDepth,
  captureRuntimeUploadRetentionCheckpoint,
  createExternalImportTreeBudget,
  createRuntimeUploadRetentionBudget,
  EXTERNAL_IMPORT_MAX_RELATIVE_PATH_BYTES,
  EXTERNAL_IMPORT_MAX_SOURCE_PATH_BYTES,
  EXTERNAL_IMPORT_MAX_SOURCE_PATHS,
  EXTERNAL_IMPORT_MAX_TREE_DEPTH,
  EXTERNAL_IMPORT_MAX_TREE_ENTRIES,
  ExternalImportCapacityError,
  REMOTE_IMPORT_MAX_FILE_BYTES,
  REMOTE_IMPORT_MAX_RETAINED_PATH_BYTES,
  REMOTE_IMPORT_MAX_TOTAL_BYTES,
  restoreRuntimeUploadRetentionCheckpoint,
  retainRuntimeUploadFileBytes
} from './filesystem-external-import-limits'

describe('external filesystem import limits', () => {
  it('accepts the exact source-count boundary and rejects the next path', () => {
    expect(() =>
      assertExternalImportSourcePaths(
        Array.from({ length: EXTERNAL_IMPORT_MAX_SOURCE_PATHS }, () => '')
      )
    ).not.toThrow()
    expect(() =>
      assertExternalImportSourcePaths(
        Array.from({ length: EXTERNAL_IMPORT_MAX_SOURCE_PATHS + 1 }, () => '')
      )
    ).toThrow('External import accepts at most 256 source paths')
  })

  it('accepts the exact source-path byte boundary and rejects one byte more', () => {
    expect(() =>
      assertExternalImportSourcePaths(['a'.repeat(EXTERNAL_IMPORT_MAX_SOURCE_PATH_BYTES)])
    ).not.toThrow()
    expect(() =>
      assertExternalImportSourcePaths(['a'.repeat(EXTERNAL_IMPORT_MAX_SOURCE_PATH_BYTES + 1)])
    ).toThrow('External import source paths exceed 256 KiB')
  })

  it('accepts exactly 100,000 tree entries without retaining their paths', () => {
    const budget = createExternalImportTreeBudget()
    for (let index = 0; index < EXTERNAL_IMPORT_MAX_TREE_ENTRIES; index += 1) {
      admitExternalImportTreeEntry(budget, 'entry', false)
    }

    expect(budget).toEqual({
      entries: EXTERNAL_IMPORT_MAX_TREE_ENTRIES,
      retainedPathBytes: 0
    })
    expect(() => admitExternalImportTreeEntry(budget, 'overflow', false)).toThrow(
      'External import tree exceeds 100,000 entries'
    )
    expect(budget.entries).toBe(EXTERNAL_IMPORT_MAX_TREE_ENTRIES)
  })

  it('accepts the exact depth and per-path boundaries', () => {
    const budget = createExternalImportTreeBudget()
    expect(() => assertExternalImportTreeDepth(EXTERNAL_IMPORT_MAX_TREE_DEPTH)).not.toThrow()
    expect(() => assertExternalImportTreeDepth(EXTERNAL_IMPORT_MAX_TREE_DEPTH + 1)).toThrow(
      'External import tree exceeds 256 nested directory levels'
    )
    expect(() =>
      admitExternalImportTreeEntry(
        budget,
        'a'.repeat(EXTERNAL_IMPORT_MAX_RELATIVE_PATH_BYTES),
        false
      )
    ).not.toThrow()
    expect(() =>
      admitExternalImportTreeEntry(
        budget,
        'a'.repeat(EXTERNAL_IMPORT_MAX_RELATIVE_PATH_BYTES + 1),
        false
      )
    ).toThrow('External import relative path exceeds 64 KiB')
  })

  it('accepts the exact aggregate retained-path boundary', () => {
    const budget = createExternalImportTreeBudget()
    const path = 'a'.repeat(EXTERNAL_IMPORT_MAX_RELATIVE_PATH_BYTES)
    const pathCount =
      REMOTE_IMPORT_MAX_RETAINED_PATH_BYTES / (EXTERNAL_IMPORT_MAX_RELATIVE_PATH_BYTES * 2)
    for (let index = 0; index < pathCount; index += 1) {
      admitExternalImportTreeEntry(budget, path, true)
    }

    expect(budget.retainedPathBytes).toBe(REMOTE_IMPORT_MAX_RETAINED_PATH_BYTES)
    expect(() => admitExternalImportTreeEntry(budget, 'b', true)).toThrow(
      'Remote import retained paths exceed 16 MiB'
    )
    expect(budget.retainedPathBytes).toBe(REMOTE_IMPORT_MAX_RETAINED_PATH_BYTES)
  })

  it('applies file and total byte limits across the full runtime-upload request', () => {
    const budget = createRuntimeUploadRetentionBudget()
    const exactFileCount = REMOTE_IMPORT_MAX_TOTAL_BYTES / REMOTE_IMPORT_MAX_FILE_BYTES
    for (let index = 0; index < exactFileCount; index += 1) {
      retainRuntimeUploadFileBytes(budget, `file-${index}`, REMOTE_IMPORT_MAX_FILE_BYTES)
    }

    expect(budget.fileBytes).toBe(REMOTE_IMPORT_MAX_TOTAL_BYTES)
    expect(() => retainRuntimeUploadFileBytes(budget, 'overflow', 1)).toThrow(
      'Remote import is too large'
    )
    expect(budget.fileBytes).toBe(REMOTE_IMPORT_MAX_TOTAL_BYTES)
  })

  it('rejects one oversized file without consuming request capacity', () => {
    const budget = createRuntimeUploadRetentionBudget()

    expect(() =>
      retainRuntimeUploadFileBytes(budget, 'large.bin', REMOTE_IMPORT_MAX_FILE_BYTES + 1)
    ).toThrow("'large.bin' is too large for remote import")
    expect(budget.fileBytes).toBe(0)
  })

  it('restores capacity reserved by a failed staged source', () => {
    const budget = createRuntimeUploadRetentionBudget()
    const checkpoint = captureRuntimeUploadRetentionCheckpoint(budget)
    admitExternalImportTreeEntry(budget.tree, 'partial.txt', true)
    retainRuntimeUploadFileBytes(budget, 'partial.txt', 1024)

    restoreRuntimeUploadRetentionCheckpoint(budget, checkpoint)

    expect(budget).toEqual({
      tree: { entries: 0, retainedPathBytes: 0 },
      fileBytes: 0
    })
  })

  it('uses a typed error for every capacity rejection', () => {
    const budget = createExternalImportTreeBudget()

    expect(() =>
      admitExternalImportTreeEntry(
        budget,
        'a'.repeat(EXTERNAL_IMPORT_MAX_RELATIVE_PATH_BYTES + 1),
        false
      )
    ).toThrow(ExternalImportCapacityError)
  })
})
