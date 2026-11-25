export type RuntimeDocPreviewReadParams = {
  worktree: string
  relativePath: string
  entryRelativePath: string
  implicitRootRelativePath: string | null
  authorizedRootRelativePaths: string[]
}
