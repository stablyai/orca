import type { FileSharer } from './file-sharer-contract'

// Native file routes mount the shell page, whose sibling asks the shell to share the file.
export function useFileSharer(): FileSharer | null {
  return null
}
