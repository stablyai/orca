// PowerShell 5.1 can strip JSON quotes at the native argv boundary; repair would lose type information.

const BARE_TOKEN = /^[A-Za-z0-9_.:+-]+$/
const BARE_OBJECT_ENTRY = /^([A-Za-z0-9_.+-]+):([A-Za-z0-9_.+-]+)$/

function splitEntries(body: string): string[] {
  return body.split(',').map((entry) => entry.trim())
}

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
    // Re-quoting must yield valid JSON; {a,b} is not a stripped object.
    return isObject
      ? splitEntries(body).every((entry) => BARE_OBJECT_ENTRY.test(entry))
      : splitEntries(body).every((entry) => BARE_TOKEN.test(entry))
  }
}

/** Never echo the value: JSON payloads can contain secrets. */
export function describeQuoteStrippedJsonFlag(flagName: string, raw: string): string | null {
  if (!looksQuoteStripped(raw)) {
    return null
  }
  // Shape alone cannot prove PowerShell was involved; other shells can receive the same invalid input.
  return (
    `--${flagName} is not valid JSON: its quotes are missing.\n` +
    'If you ran this from Windows PowerShell 5.1, it strips inner quotes when building a native ' +
    'command line, so a correct value can still arrive damaged.\n' +
    `Pass it through a variable instead: $v = '<json>'; orca ... --${flagName} $v — or run the ` +
    'command from cmd.exe, Git Bash, or PowerShell 7+.'
  )
}
