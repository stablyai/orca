const MASKED_TEXT_MAX_CHARS = 160

// Mask paths/file URLs before clamping; page and schema text can quote user locations.
export function maskUserText(text: string): string {
  const masked = text
    .replace(/file:\/\/[^\s)'"`\]]+/g, '[path]')
    // Continue through whitespace when the next word still contains a separator, as in C:\Users\John Doe\x.
    .replace(
      /(^|[\s'"`([=:,])(?:~?\/|[A-Za-z]:[\\/]|\\\\)[^\s)'"`\]]+(?: [^\s)'"`\]]*[\\/][^\s)'"`\]]*)*/g,
      '$1[path]'
    )
  return masked.length > MASKED_TEXT_MAX_CHARS
    ? `${masked.slice(0, MASKED_TEXT_MAX_CHARS)}…`
    : masked
}
