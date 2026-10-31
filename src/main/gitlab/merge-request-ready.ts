import { extractExecError } from '../git/exec-error'
import { parseGlabApiResponse } from './glab-api-response'
import { glabExecFileAsync } from './gl-utils'

function isResponseObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseDraftResponse(stdout: string): { body: string; status?: number } {
  const status = /^HTTP\/\d+(?:\.\d+)?\s+(\d{3})(?:\s|$)/.exec(stdout)?.[1]
  return { body: parseGlabApiResponse(stdout).body, status: status ? Number(status) : undefined }
}

function isUnsupportedDraftMutation(stdout: string, stderr: string): boolean {
  const response = parseDraftResponse(stdout)
  if (
    /\b(?:unauthorized|forbidden|insufficient_scope|access denied|not authorized)\b/i.test(stderr)
  ) {
    return false
  }
  if (response.status === 404) {
    return true
  }
  if (response.status !== undefined && response.status !== 200) {
    return false
  }
  try {
    const payload: unknown = JSON.parse(response.body)
    return (
      isResponseObject(payload) &&
      !payload.data &&
      Array.isArray(payload.errors) &&
      payload.errors.length > 0 &&
      payload.errors.every((error: unknown) => {
        if (!isResponseObject(error)) {
          return false
        }
        const extensions = error.extensions
        return (
          (isResponseObject(extensions) &&
            extensions.code === 'undefinedField' &&
            extensions.typeName === 'Mutation' &&
            extensions.fieldName === 'mergeRequestSetDraft') ||
          (!extensions &&
            (error.message === "Field 'mergeRequestSetDraft' doesn't exist on type 'Mutation'" ||
              error.message === 'Schema is not configured for mutations'))
        )
      })
    )
  } catch {
    return false
  }
}

export async function tryMarkMRReady(
  args: string[],
  options: Parameters<typeof glabExecFileAsync>[1],
  iid: number
): Promise<boolean> {
  let stdout: string
  try {
    ;({ stdout } = await glabExecFileAsync(args, options))
  } catch (error) {
    const output = extractExecError(error)
    // A terminated command cannot confirm that GitLab rejected the operation before execution.
    if (
      isResponseObject(error) &&
      error.code === 1 &&
      !error.killed &&
      !error.signal &&
      isUnsupportedDraftMutation(output.stdout, output.stderr)
    ) {
      return false
    }
    throw error
  }

  const failure = new Error('GitLab could not mark the merge request ready. Try again.')
  const response = parseDraftResponse(stdout)
  let payload: unknown
  try {
    payload = JSON.parse(response.body)
  } catch {
    throw failure
  }
  const mutation =
    isResponseObject(payload) && isResponseObject(payload.data)
      ? payload.data.mergeRequestSetDraft
      : undefined
  if (
    (response.status !== undefined && response.status !== 200) ||
    !isResponseObject(payload) ||
    (payload.errors !== undefined &&
      (!Array.isArray(payload.errors) || payload.errors.length > 0)) ||
    !isResponseObject(mutation) ||
    !Array.isArray(mutation.errors) ||
    mutation.errors.length > 0 ||
    !isResponseObject(mutation.mergeRequest) ||
    mutation.mergeRequest.iid !== String(iid)
  ) {
    throw failure
  }
  return true
}
