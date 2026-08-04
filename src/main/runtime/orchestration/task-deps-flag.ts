// Why: --deps is documented as a JSON string array. On WSL the PowerShell
// bridge used to strip ASCII double quotes before orca.exe saw argv (#12231),
// so `["task_abc"]` arrived as `[task_abc]` and every non-empty JSON form
// failed while `[]` still worked (#12188). Accept canonical JSON and a few
// lossless recoveries of the quote-stripped form — still require task_* ids.

const TASK_ID_PATTERN = /^task_[a-f0-9]+$/i

export function parseOrchestrationTaskDepsFlag(raw: string): string[] {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return []
  }

  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (Array.isArray(parsed)) {
      return requireTaskIds(parsed)
    }
  } catch {
    // fall through to quote-stripped / CSV recoveries
  }

  const recovered = recoverNonJsonTaskDeps(trimmed)
  if (recovered) {
    return recovered
  }

  throw new Error('Invalid --deps: must be a JSON array of task IDs')
}

function requireTaskIds(entries: unknown[]): string[] {
  const ids: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'string' || !TASK_ID_PATTERN.test(entry)) {
      throw new Error('Invalid --deps: must be a JSON array of task IDs')
    }
    ids.push(entry)
  }
  return ids
}

function recoverNonJsonTaskDeps(raw: string): string[] | null {
  const bracketed = raw.match(/^\[([\s\S]*)\]$/)
  const body = bracketed ? bracketed[1].trim() : raw
  if (bracketed && body.length === 0) {
    return []
  }

  // Why: reject empty CSV segments (task_a,,task_b) — not a lossless recovery.
  if (body.split(',').some((segment) => segment.trim().length === 0)) {
    return null
  }

  const parts = body.split(',').map((part) => stripBalancedQuotes(part.trim()))
  if (parts.length === 0) {
    return null
  }
  if (!parts.every((part) => TASK_ID_PATTERN.test(part))) {
    return null
  }
  return parts
}

function stripBalancedQuotes(token: string): string {
  if (
    (token.startsWith('"') && token.endsWith('"') && token.length >= 2) ||
    (token.startsWith("'") && token.endsWith("'") && token.length >= 2)
  ) {
    return token.slice(1, -1)
  }
  return token
}
