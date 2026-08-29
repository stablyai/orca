export type DaemonHostCopyOperation = {
  sourcePath: string
  /** Destination path relative to the host root, posix-separated. */
  destRel: string
  kind: 'file' | 'dir'
  /** When true, a missing source is skipped rather than failing the copy. */
  optional?: boolean
  /** Per-source-path predicate for dir copies: return false to skip a path. */
  filter?: (sourcePath: string) => boolean
}
