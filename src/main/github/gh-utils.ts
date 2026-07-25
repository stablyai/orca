import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { gitExecFileAsync, ghExecFileAsync } from '../git/runner'
// Pure error-parsing helpers come from the lightweight module (not `runner`) so
// tests that mock `../git/runner` still resolve the real implementations.
import { extractExecError, parseRetryAfterMs } from '../git/exec-error'

// Why: legacy generic execFile wrapper - only used by callers that don't need
// WSL-aware routing. Repo-scoped callers should use the runner exports below.
export const execFileAsync = promisify(execFile)
export { ghExecFileAsync, gitExecFileAsync, extractExecError, parseRetryAfterMs }
export { classifyGhError, classifyListIssuesError } from './gh-error-classification'
export {
  _getOwnerRepoCacheSize,
  _resetOwnerRepoCache,
  getIssueOwnerRepo,
  getOwnerRepo,
  getOwnerRepoForRemote,
  getRemoteUrlForRepo,
  ghRepoExecOptions,
  githubRepoContext,
  parseGitHubOwnerRepo,
  parseGitHubRemoteIdentity,
  resolveIssueSource,
  resolvePRRepositoryCandidates
} from './github-repository-identity'
export type {
  GitHubRemoteIdentity,
  GitHubRepoContext,
  LocalGitExecOptions,
  OwnerRepo,
  PRRepositoryCandidates,
  ResolvedIssueSource
} from './github-repository-identity'

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
