import type { FileSaver } from './file-saver-contract'

// Native file routes mount the shell page, whose sibling asks the shell to save the file.
// Native screens never render the preview themselves, so there is no saver here.
export function useFileSaver(): FileSaver | null {
  return null
}
