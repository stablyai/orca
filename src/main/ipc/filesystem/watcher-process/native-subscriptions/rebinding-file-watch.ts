import { statSync, type BigIntStats } from 'node:fs'
import { createRebindingFileWatch, type RebindingFileWatch } from './rebinding-file-watch-owner'
export { closeFileSystemWatcher, type RebindingFileWatch } from './rebinding-file-watch-owner'

export function watchFileAcrossReplacement(
  path: string,
  onChange: () => void,
  onError: (error: Error) => void
): RebindingFileWatch {
  let initial: BigIntStats | null = null
  try {
    initial = statSync(path, { bigint: true })
  } catch {}
  return createRebindingFileWatch(path, onChange, onError, initial)
}
