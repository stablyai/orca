export type EntryKind = 'directory' | 'file' | 'link' | 'other' | null
export type MoveResult = 'moved' | 'collision' | 'missing'
export type HistoryDirectory = {
  entries(): string[]
  kind(name: string): EntryKind
  open(name: string): HistoryDirectory
  /** POSIX gives the new directory `like`'s permission bits. */
  mkdir(name: string, like?: HistoryDirectory): void
  /**
   * Never replaces: an occupied target is a collision that keeps both names, except on Windows
   * when the target is the same file (a hard link), where the move completes with the bytes intact.
   * `directoryOnly` refuses a non-directory source atomically on Windows; POSIX callers reclassify what they staged.
   */
  move(
    name: string,
    destination: HistoryDirectory,
    target: string,
    directoryOnly?: boolean
  ): MoveResult
  link(name: string, target: string): void
  readLink(name: string): string
  removeEmpty(name: string): void
  /** Reads a regular file; a link is refused, never followed. */
  read(name: string): Buffer
  /** `create` makes the file exclusively; otherwise an existing file is overwritten from its start, never created. */
  write(name: string, data: string, create: boolean): void
  /** Removes a non-directory entry itself, never a link's referent. */
  unlink(name: string): void
  /** The entry's own volume and file ID as `dev:ino`; equal for two names of one file. */
  identity(name: string): string
  same(other: HistoryDirectory): boolean
  sameDevice(other: HistoryDirectory): boolean
  close(): void
}
export function openDirectory(path: string, followRoot: boolean): HistoryDirectory
