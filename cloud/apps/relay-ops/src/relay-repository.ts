// Single place naming the GitHub repository that holds the Relay workflows. When the Relay tree is
// copied to its public repository, only this file changes: the repository moves and every workflow
// file gains a prefix, while the workflow display names stay as they are.
export const RELAY_GITHUB_REPOSITORY = 'stablyai/orca-cloud'

export const RELAY_WORKFLOW_FILE_PREFIX = ''

export function relayWorkflowFile(name: string): string {
  return `${RELAY_WORKFLOW_FILE_PREFIX}${name}`
}

export function relayRepositoryApiPath(resource: string): string {
  return `repos/${RELAY_GITHUB_REPOSITORY}/${resource}`
}
