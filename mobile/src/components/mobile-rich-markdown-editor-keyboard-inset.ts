/**
 * The inset the document reports, as the host reads it.
 *
 * Native `Keyboard` events under-report the area covered while focus lives inside the editor's
 * WebView, so the document measures the covered region itself and posts it. This is the host's
 * half: a measurement that is not a finite number is no measurement, and the caller keeps the
 * inset it had rather than lifting its bar by `NaN`.
 */
export function normalizeMobileRichMarkdownKeyboardInset(value: number): number | null {
  if (!Number.isFinite(value)) {
    return null
  }
  return Math.max(0, Math.round(value))
}
