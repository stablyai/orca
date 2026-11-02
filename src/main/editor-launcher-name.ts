import { basename, win32 } from 'node:path'

export function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim()
  const quote = trimmed[0]
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function hasMatchingOuterQuotes(value: string): boolean {
  const trimmed = value.trim()
  const quote = trimmed[0]
  return (quote === '"' || quote === "'") && trimmed.endsWith(quote)
}

function getLeadingShellCommandToken(command: string): string {
  const trimmed = command.trim()
  const quote = trimmed[0]
  if (quote === '"' || quote === "'") {
    const closingIndex = trimmed.indexOf(quote, 1)
    if (closingIndex > 0) {
      return trimmed.slice(1, closingIndex)
    }
  }
  return trimmed.split(/\s+/, 1)[0] ?? ''
}

/** Lowercased launcher name without directory or Windows executable extension. */
export function getLauncherBaseName(
  command: string,
  options: { shellCommand?: boolean } = {}
): string {
  const normalized = options.shellCommand
    ? getLeadingShellCommandToken(command)
    : stripMatchingQuotes(command)
  const name = normalized.includes('\\') ? win32.basename(normalized) : basename(normalized)
  return name.replace(/\.(?:cmd|exe|bat)$/i, '').toLowerCase()
}

export function isWindowsBatchLauncher(command: string): boolean {
  return /\.(?:cmd|bat)$/i.test(stripMatchingQuotes(command))
}
