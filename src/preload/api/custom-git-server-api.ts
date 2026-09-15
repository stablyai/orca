import type {
  CustomGitServer,
  CustomGitServerDraft,
  CustomGitServerStatus,
  CustomGitServerTestResult
} from '../../shared/custom-git-server'

export type CustomGitServerApi = {
  list: () => Promise<CustomGitServer[]>
  save: (draft: CustomGitServerDraft & { id?: string }) => Promise<CustomGitServer>
  remove: (args: { id: string }) => Promise<void>
  test: (draft: CustomGitServerDraft & { token: string }) => Promise<CustomGitServerTestResult>
  status: () => Promise<CustomGitServerStatus[]>
}
