const TASK_ID_PATTERN = /^task_[a-z0-9_-]+$/i
const ERROR_MESSAGE = 'Invalid --deps: must be a JSON array of task IDs'

export function parseOrchestrationTaskDepsFlag(raw: string): string[] {
  const trimmed = raw.trim()

  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) {
      return parsed
    }
  } catch {
    // The WSL PowerShell 5.1 bridge strips JSON string quotes from native argv.
  }

  const recovered = recoverQuoteStrippedJsonArray(trimmed)
  if (recovered) {
    return recovered
  }

  throw new Error(ERROR_MESSAGE)
}

function recoverQuoteStrippedJsonArray(raw: string): string[] | null {
  const bracketed = raw.match(/^\[([\s\S]*)\]$/)
  if (!bracketed) {
    return null
  }

  const parts = bracketed[1].split(',').map((part) => part.trim())
  if (parts.some((part) => !TASK_ID_PATTERN.test(part))) {
    return null
  }
  return parts
}
