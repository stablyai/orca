// Resolves a data URI of a workspace PDF's first page, or null when it cannot be drawn.
export type PdfThumbnailer = (worktreeId: string, relativePath: string) => Promise<string | null>

// Native file routes mount the shell page, whose sibling asks the shell to draw the page.
export function usePdfThumbnailer(): PdfThumbnailer | null {
  return null
}
