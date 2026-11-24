import type { ImageActionsFor } from './image-actions-contract'

// Chat and file previews render only in the shell page, whose sibling asks the shell for the clipboard, Photos and share sheet.
export function useImageActions(): ImageActionsFor | null {
  return null
}
