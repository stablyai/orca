import type { FileSaver } from './file-saver-contract'

// Native file routes mount the shell page, whose sibling asks the shell to save the file.
export function useFileSaver(): FileSaver | null {
  return null
}
