const INVALID_DEPS_ERROR = 'Invalid --deps: must be a JSON array of task IDs'
const GENERATED_TASK_ID_PATTERN = /^task_[0-9a-f]{12}$/i

// Windows PowerShell 5.1 strips the quotes in `["task_x"]` at the native argv boundary.
export function parseOrchestrationTaskDepsFlag(raw: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const recovered = recoverArgvStrippedTaskDeps(raw)
    if (recovered) {
      return recovered
    }
    throw new Error(INVALID_DEPS_ERROR)
  }

  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
    throw new Error(INVALID_DEPS_ERROR)
  }
  return parsed
}

function recoverArgvStrippedTaskDeps(raw: string): string[] | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return null
  }
  const body = trimmed.slice(1, -1).trim()
  if (body.length === 0) {
    return []
  }
  const ids = body.split(',').map((entry) => entry.trim())
  return ids.every((id) => GENERATED_TASK_ID_PATTERN.test(id)) ? ids : null
}
