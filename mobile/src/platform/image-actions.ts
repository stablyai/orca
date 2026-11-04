import type { ImageActions } from './image-actions-contract'

// Chat and file previews render only in the shell page, whose sibling asks the shell for the clipboard, Photos and share sheet.
export function useImageActions(): ImageActions | null {
  return null
}
