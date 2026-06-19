// Why: these limits must match desktop cache/fetch behavior, but mobile cannot
// import root shared modules at runtime because Metro resolves from mobile/.
export const PER_REPO_FETCH_LIMIT = 36
export const CROSS_REPO_DISPLAY_LIMIT = 100

const GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE =
  'GitHub work items require a GitHub remote for SSH repositories'

export function isGitHubWorkItemsSshRemoteRequiredError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' &&
          error !== null &&
          'message' in error &&
          typeof error.message === 'string'
        ? error.message
        : typeof error === 'string'
          ? error
          : ''

  return message.includes(GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE)
}
