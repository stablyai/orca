export type ImportSkipReason = 'missing' | 'symlink' | 'permission-denied' | 'unsupported'

export type ResolveDroppedPathsResult = {
  resolvedPaths: string[]
  skipped: { sourcePath: string; reason: ImportSkipReason }[]
  failed: { sourcePath: string; reason: string }[]
}

// ─── External Import Types ──────────────────────────────────────────

export type ImportItemResult =
  | {
      sourcePath: string
      status: 'imported'
      destPath: string
      kind: 'file' | 'directory'
      renamed: boolean
    }
  | {
      sourcePath: string
      status: 'skipped'
      reason: ImportSkipReason
    }
  | {
      sourcePath: string
      status: 'failed'
      reason: string
    }

export type StagedExternalImportSource =
  | {
      sourcePath: string
      status: 'staged'
      name: string
      kind: 'file' | 'directory'
      entries: StagedExternalImportEntry[]
    }
  | {
      sourcePath: string
      status: 'skipped'
      reason: ImportSkipReason
    }
  | {
      sourcePath: string
      status: 'failed'
      reason: string
    }

export type StagedExternalImportEntry =
  | { relativePath: string; kind: 'directory' }
  | { relativePath: string; kind: 'file'; contentBase64: string }
