import { gitExecFileAsync, glabExecFileAsync } from '../git/runner'
import { parseGlabApiResponse, type GlabApiResponse } from './glab-api-response'

export { glabExecFileAsync, gitExecFileAsync }
export {
  classifyGlabError,
  classifyJobLogError,
  classifyListFetchError,
  classifyListIssuesError,
  isMissingJobLogError
} from './glab-error-classification'
export {
  DEFAULT_GITLAB_HOSTS,
  _getProjectRefCacheSize,
  _resetKnownHostsCache,
  _resetProjectRefCache,
  getGlabKnownHosts,
  getIssueProjectRef,
  getProjectRef,
  getProjectRefForRemote,
  glabHostnameArgs,
  glabRepoExecOptions,
  parseGlabAuthStatusHosts,
  parseGitLabProjectRef,
  resolveIssueSource
} from './gitlab-project-ref-resolution'
export type {
  LocalGitExecOptions,
  ProjectRef,
  ResolvedIssueSource
} from './gitlab-project-ref-resolution'
export { parseGlabApiResponse, parseGlabJsonList, type GlabApiResponse } from './glab-api-response'

const MAX_CONCURRENT = 4
let running = 0
const queue: (() => void)[] = []

export function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running += 1
    return Promise.resolve()
  }
  return new Promise((resolve) =>
    queue.push(() => {
      running += 1
      resolve()
    })
  )
}

export function release(): void {
  running -= 1
  const next = queue.shift()
  if (next) {
    next()
  }
}

export async function glabApiWithHeaders(
  args: string[],
  options?: { cwd?: string }
): Promise<GlabApiResponse> {
  const { stdout } = await glabExecFileAsync(['api', '-i', ...args], options)
  return parseGlabApiResponse(stdout)
}
