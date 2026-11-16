// Document reports WebView keyboard cover because native Keyboard undercounts it. Ignore non-finite measurements and retain prior inset instead of lifting by NaN.
export function normalizeMobileRichMarkdownKeyboardInset(value: number): number | null {
  if (!Number.isFinite(value)) {
    return null
  }
  return Math.max(0, Math.round(value))
}
