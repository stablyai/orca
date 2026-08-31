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
export {
  parseGlabApiResponse,
  parseGlabJsonList,
  parseGlabPaginationHeader,
  type GlabApiResponse
} from './glab-api-response'

const MAX_CONCURRENT = 4
export const GITLAB_ADMISSION_TIMEOUT_MS = 30_000
let running = 0
type QueueEntry = {
  grant: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  cancelled: boolean
}
const queue: QueueEntry[] = []

export function acquire(timeoutMs = GITLAB_ADMISSION_TIMEOUT_MS): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running += 1
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const entry: QueueEntry = {
      grant: () => {
        clearTimeout(entry.timer)
        running += 1
        resolve()
      },
      reject: (error) => {
        clearTimeout(entry.timer)
        reject(error)
      },
      timer: setTimeout(() => {
        entry.cancelled = true
        const index = queue.indexOf(entry)
        if (index !== -1) {
          queue.splice(index, 1)
        }
        entry.reject(new Error('Timed out waiting for a GitLab operation slot.'))
      }, timeoutMs),
      cancelled: false
    }
    queue.push(entry)
  })
}

export function release(): void {
  running -= 1
  while (queue.length > 0) {
    const next = queue.shift()
    if (!next || next.cancelled) {
      continue
    }
    next.grant()
    return
  }
}

export async function glabApiWithHeaders(
  args: string[],
  options?: Parameters<typeof glabExecFileAsync>[1]
): Promise<GlabApiResponse> {
  const { stdout } = await glabExecFileAsync(['api', '-i', ...args], options)
  return parseGlabApiResponse(stdout)
}
