export type EntryKind = 'directory' | 'file' | 'link' | 'other' | null
export type MoveResult = 'moved' | 'collision' | 'missing'
export type HistoryDirectory = {
  entries(): string[]
  kind(name: string): EntryKind
  open(name: string): HistoryDirectory
  mkdir(name: string): void
  move(
    name: string,
    destination: HistoryDirectory,
    target: string,
    directoryOnly?: boolean
  ): MoveResult
  link(name: string, target: string): void
  readLink(name: string): string
  removeEmpty(name: string): void
  same(other: HistoryDirectory): boolean
  sameDevice(other: HistoryDirectory): boolean
  close(): void
}
export function openDirectory(path: string, followRoot: boolean): HistoryDirectory
