/**
 * Windows PowerShell 5.1 does not escape inner quotes when it builds a native command line, so
 * `--options '["a","b"]'` reaches the exe as `--options [a,b]` (#16706). The value is correct when
 * printed and damaged by the time argv is parsed, which makes the resulting "invalid JSON" error
 * point at the user's input rather than at the shell that mangled it.
 *
 * Detection only — recovery is deliberately not attempted here. Un-quoting is lossy for anything
 * but a strict grammar: `["1","2"]` and `[1,2]` arrive identically, so a general repair would
 * silently change strings into numbers. `--deps` is recoverable only because generated task IDs
 * have a fixed shape (see `task-deps-flag.ts`).
 */

const BARE_TOKEN = /^[A-Za-z0-9_.:+-]+$/

/** Whether `raw` looks like JSON whose quotes a native argv boundary stripped. */
export function looksQuoteStripped(raw: string): boolean {
  const trimmed = raw.trim()
  const bracketed =
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
  if (!bracketed || trimmed.includes('"')) {
    return false
  }
  try {
    JSON.parse(trimmed)
    return false
  } catch {
    // Only claim mangling when every element is a bare token that quoting would make valid.
    const body = trimmed.slice(1, -1).trim()
    if (body.length === 0) {
      return false
    }
    return body
      .split(',')
      .map((entry) => entry.trim())
      .every((entry) => {
        const [key, value] = entry.includes(':') ? entry.split(':', 2) : [entry, undefined]
        return BARE_TOKEN.test(key.trim()) && (value === undefined || BARE_TOKEN.test(value.trim()))
      })
  }
}

/**
 * Error text for a JSON flag whose quotes were stripped, naming the shell rather than blaming the
 * value. Returns null when `raw` is not the mangled shape.
 */
export function describeQuoteStrippedJsonFlag(flagName: string, raw: string): string | null {
  if (!looksQuoteStripped(raw)) {
    return null
  }
  return (
    `--${flagName} arrived as ${raw.trim()}, which is not valid JSON.\n` +
    'Windows PowerShell 5.1 strips the inner quotes when it builds a native command line, so a ' +
    'correct value can still arrive damaged.\n' +
    `Pass it through a variable instead: $v = '<json>'; orca ... --${flagName} $v — or run the ` +
    'command from cmd.exe, Git Bash, or PowerShell 7+.'
  )
}
