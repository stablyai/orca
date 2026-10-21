import { formatPreviewByteLength } from '../files/mobile-file-preview-response'
import type { MarkdownDocState } from './mobile-session-route-types'

/** The markdown floating bar's status line; a truncated preview reads like a file tab's note. */
export function markdownReaderStatusText(
  doc: Extract<MarkdownDocState, { status: 'ready' }>
): string | null {
  if (doc.saveError) {
    return doc.saveError
  }
  if (doc.truncated) {
    return doc.byteLength === undefined
      ? 'Preview truncated.'
      : `Preview truncated. File size: ${formatPreviewByteLength(doc.byteLength)}.`
  }
  if (doc.readOnlyReason) {
    return 'Read only'
  }
  return doc.stale ? 'Changed on desktop' : null
}
