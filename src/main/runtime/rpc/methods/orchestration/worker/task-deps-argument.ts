import { OrchestrationError } from '../../../../orchestration/orchestration-error'

/** Parses the `--deps` JSON argument shared by the local and federated start paths. */
export function parseTaskDeps(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined
  }
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
      throw new Error('not an array of strings')
    }
    return parsed
  } catch {
    throw new OrchestrationError(
      'invalid_argument',
      'Invalid --deps: must be a JSON array of task IDs'
    )
  }
}
