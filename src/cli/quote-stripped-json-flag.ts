/**
 * Windows PowerShell 5.1 does not escape inner quotes when it builds a native command line, so
 * `--payload '{"a":"b"}'` reaches the exe as `--payload {a:b}` (#16706). The value is correct when
 * printed and damaged by the time argv is parsed, which makes the resulting "invalid JSON" error
 * point at the user's input rather than at the shell that mangled it.
 *
 * Detection only — recovery is deliberately not attempted. Un-quoting is lossy for anything but a
 * strict grammar: `["1","2"]` and `[1,2]` arrive identically, so a general repair would silently
 * turn strings into numbers. `--deps` is recoverable only because generated task IDs have a fixed
 * shape (see `task-deps-flag.ts`).
 */

const BARE_TOKEN = /^[A-Za-z0-9_.:+-]+$/
const BARE_OBJECT_ENTRY = /^([A-Za-z0-9_.+-]+):([A-Za-z0-9_.+-]+)$/

function splitEntries(body: string): string[] {
  return body.split(',').map((entry) => entry.trim())
}

/** Whether `raw` looks like JSON whose quotes a native argv boundary stripped. */
export function looksQuoteStripped(raw: string): boolean {
  const trimmed = raw.trim()
  if (trimmed.includes('"')) {
    return false
  }
  const isArray = trimmed.startsWith('[') && trimmed.endsWith(']')
  const isObject = trimmed.startsWith('{') && trimmed.endsWith('}')
  if (!isArray && !isObject) {
    return false
  }
  try {
    JSON.parse(trimmed)
    return false
  } catch {
    const body = trimmed.slice(1, -1).trim()
    if (body.length === 0) {
      return false
    }
    // Why: only claim mangling when re-quoting every entry would actually produce valid JSON.
    // An object needs a `key:value` pair per entry; `{a,b}` is not a stripped object.
    return isObject
      ? splitEntries(body).every((entry) => BARE_OBJECT_ENTRY.test(entry))
      : splitEntries(body).every((entry) => BARE_TOKEN.test(entry))
  }
}

/**
 * Error text for a JSON flag whose quotes were stripped. Returns null when `raw` is not that shape.
 *
 * The value itself is never echoed: a `--payload` can carry secrets, and this message reaches both
 * human and `--json` output. The shape is already described by the flag name and the guidance.
 */
export function describeQuoteStrippedJsonFlag(flagName: string, raw: string): string | null {
  if (!looksQuoteStripped(raw)) {
    return null
  }
  // Why conditional wording: this inspects only the value's shape, so it also fires when someone
  // types an unquoted `[a,b]` on macOS or Linux, where PowerShell is not involved.
  return (
    `--${flagName} is not valid JSON: its quotes are missing.\n` +
    'If you ran this from Windows PowerShell 5.1, it strips inner quotes when building a native ' +
    'command line, so a correct value can still arrive damaged.\n' +
    `Pass it through a variable instead: $v = '<json>'; orca ... --${flagName} $v — or run the ` +
    'command from cmd.exe, Git Bash, or PowerShell 7+.'
  )
}
