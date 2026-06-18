import { execFile } from 'child_process'
import { promisify } from 'util'
import { gitExecFileAsync, glabExecFileAsync } from '../git/runner'

// Why: legacy generic execFile wrapper - only used by callers that don't need
// WSL-aware routing. Repo-scoped callers should use the runner exports below.
export const execFileAsync = promisify(execFile)
export { glabExecFileAsync, gitExecFileAsync }
export { classifyGlabError, classifyListIssuesError } from './glab-error-classification'
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

export type GlabApiResponse = {
  body: string
  headers: Record<string, string>
}

export async function glabApiWithHeaders(
  args: string[],
  options?: { cwd?: string }
): Promise<GlabApiResponse> {
  const { stdout } = await glabExecFileAsync(['api', '-i', ...args], options)
  return parseGlabApiResponse(stdout)
}

/** @internal - exported for tests. */
export function parseGlabApiResponse(stdout: string): GlabApiResponse {
  const sepMatch = stdout.match(/\r?\n\r?\n/)
  if (!sepMatch || sepMatch.index === undefined) {
    return { body: stdout, headers: {} }
  }
  const headerBlock = stdout.slice(0, sepMatch.index)
  const body = stdout.slice(sepMatch.index + sepMatch[0].length)
  const headers: Record<string, string> = {}
  const lines = headerBlock.split(/\r?\n/)
  for (const line of lines) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/)
    if (m) {
      headers[m[1].toLowerCase()] = m[2].trim()
    }
  }
  return { body, headers }
}
