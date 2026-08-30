import type {
  GitHubAccountStatus,
  GitHubCloneRepoArgs,
  GitHubCloneRepoResult,
  GitHubConnectTokenResult,
  GitHubDeleteClonedRepoFilesResult,
  GitHubDeviceFlowPollResult,
  GitHubDeviceFlowStartResult,
  GitHubRepoListResult
} from '../../shared/github-account'

export type GitHubAuthApi = {
  status: () => Promise<GitHubAccountStatus>
  connectWithToken: (args: { token: string }) => Promise<GitHubConnectTokenResult>
  startDeviceFlow: () => Promise<GitHubDeviceFlowStartResult>
  pollDeviceFlow: (args: { deviceCode: string }) => Promise<GitHubDeviceFlowPollResult>
  disconnect: () => Promise<void>
  listRepos: () => Promise<GitHubRepoListResult>
  cloneRepo: (args: GitHubCloneRepoArgs) => Promise<GitHubCloneRepoResult>
  deleteClonedRepoFiles: (args: { repoId: string }) => Promise<GitHubDeleteClonedRepoFilesResult>
}
