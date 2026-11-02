const MASKED_TEXT_MAX_CHARS = 160

/** Absolute paths and file URLs masked, then clamped: page and schema text can quote user paths. */
export function maskUserText(text: string): string {
  const masked = text
    .replace(/file:\/\/[^\s)'"`\]]+/g, '[path]')
    // A following word that still holds a separator is the same path (`C:\Users\John Doe\x`).
    .replace(
      /(^|[\s'"`([=:,])(?:~?\/|[A-Za-z]:[\\/]|\\\\)[^\s)'"`\]]+(?: [^\s)'"`\]]*[\\/][^\s)'"`\]]*)*/g,
      '$1[path]'
    )
  return masked.length > MASKED_TEXT_MAX_CHARS
    ? `${masked.slice(0, MASKED_TEXT_MAX_CHARS)}…`
    : masked
}
