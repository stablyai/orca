// Record only the ERR_* code: Electron error messages embed private install URLs.
export function mainWindowLoadErrorCode(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined
  if (code && /^ERR_[A-Z0-9_]+$/.test(code)) {
    return code
  }
  const message = error instanceof Error ? error.message : String(error)
  return /\bERR_[A-Z0-9_]+/.exec(message)?.[0] ?? 'unknown'
}
