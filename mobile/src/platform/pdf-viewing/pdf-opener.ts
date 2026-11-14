import type { PdfOpener } from './pdf-opener-contract'

// Native file routes mount the shell page, whose sibling asks the shell to open the PDF.
export function usePdfOpener(): PdfOpener | null {
  return null
}
