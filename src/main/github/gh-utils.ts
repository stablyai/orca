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
export {
  classifyGhError,
  classifyListIssuesError,
  classifyListPrsError,
  classifyPullRequestUpdateError
} from './gh-error-classification'
export {
  _getOwnerRepoCacheSize,
  _resetOwnerRepoCache,
  getOwnerRepoForRemote,
  getRemoteUrlForRepo,
  ghRepoExecOptions,
  githubRepoContext,
  parseGitHubOwnerRepo,
  parseGitHubRemoteIdentity
} from './github-repository-identity'
export type {
  GitHubRemoteIdentity,
  GitHubRemoteIdentityProbeOptions,
  GitHubRepoContext,
  LocalGitExecOptions,
  OwnerRepo
} from './github-repository-identity'
export {
  getIssueOwnerRepo,
  getOwnerRepo,
  resolveIssueSource,
  resolvePRRepositoryCandidates
} from './github-owner-repo-selection'
export type { PRRepositoryCandidates, ResolvedIssueSource } from './github-owner-repo-selection'

const MAX_CONCURRENT = 4
let running = 0
type QueueEntry = {
  signal?: AbortSignal
  start: () => void
  reject: (error: Error) => void
}
const queue: QueueEntry[] = []

function githubOperationAbortError(): Error {
  const error = new Error('GitHub operation aborted')
  error.name = 'AbortError'
  return error
}

export function acquire(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(githubOperationAbortError())
  }
  if (running < MAX_CONCURRENT) {
    running += 1
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const entry: QueueEntry = {
      signal,
      reject,
      start: () => {
        signal?.removeEventListener('abort', onAbort)
        running += 1
        resolve()
      }
    }
    const onAbort = (): void => {
      const index = queue.indexOf(entry)
      if (index === -1) {
        return
      }
      queue.splice(index, 1)
      reject(githubOperationAbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    queue.push(entry)
  })
}

export function release(): void {
  running -= 1
  const next = queue.shift()
  next?.start()
}
