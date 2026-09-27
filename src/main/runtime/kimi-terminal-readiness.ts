const SESSIONLESS_NOTICE = 'no session yet — one will be created on your first message.'

/** Kimi 2 creates its session lazily, so startup has no SessionStart/Stop hook. */
export function findKimiSessionlessReadyPromptIndex(normalized: string): number | null {
  const header = normalized.lastIndexOf('welcome to kimi code!')
  const notice = normalized.lastIndexOf(SESSIONLESS_NOTICE)
  if (header === -1 || notice < header) {
    return null
  }
  const banner = normalized.slice(header, notice)
  if (
    !banner.includes('directory:') ||
    !banner.includes('model:') ||
    !banner.includes('version:')
  ) {
    return null
  }
  // Runtime tail replay ends at the input caret, before the footer painted below it.
  const lines = normalized
    .slice(notice)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (
    lines.length !== 3 ||
    lines[0] !== SESSIONLESS_NOTICE ||
    !/^╭─+╮$/.test(lines[1]) ||
    !/^│\s*>\s*│$/.test(lines[2])
  ) {
    return null
  }
  return notice
}
