import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { gitExecFileAsync, ghExecFileAsync } from '../git/runner'
// Pure error-parsing helpers come from the lightweight module (not `runner`) so
// tests that mock `../git/runner` still resolve the real implementations.
import { extractExecError, parseRetryAfterMs } from '../git/exec-error'
import { IntegrationApiConcurrencyGate } from '../integration-api-concurrency'

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
const concurrencyGate = new IntegrationApiConcurrencyGate(MAX_CONCURRENT)

export function acquire(): Promise<void> {
  return concurrencyGate.acquire()
}

export function release(): void {
  concurrencyGate.release()
}
