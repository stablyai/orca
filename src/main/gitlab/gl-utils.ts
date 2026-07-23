import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { gitExecFileAsync, glabExecFileAsync } from '../git/runner'
import { parseGlabApiResponse, type GlabApiResponse } from './glab-api-response'
import { IntegrationApiConcurrencyGate } from '../integration-api-concurrency'

// Why: legacy generic execFile wrapper - only used by callers that don't need
// WSL-aware routing. Repo-scoped callers should use the runner exports below.
export const execFileAsync = promisify(execFile)
export { glabExecFileAsync, gitExecFileAsync }
export { classifyGlabError, classifyListIssuesError } from './glab-error-classification'
export {
  DEFAULT_GITLAB_HOSTS,
  GLAB_KNOWN_HOST_MAX_BYTES,
  GLAB_KNOWN_HOSTS_CONTEXT_KEYS_MAX_BYTES,
  GLAB_KNOWN_HOSTS_CONTEXT_KEY_MAX_BYTES,
  GLAB_KNOWN_HOSTS_CONTEXT_MAX_ENTRIES,
  GLAB_KNOWN_HOSTS_MAX_BYTES,
  GLAB_KNOWN_HOSTS_MAX_ENTRIES,
  GLAB_KNOWN_HOSTS_MAX_IN_FLIGHT,
  GLAB_KNOWN_HOSTS_OUTPUT_MAX_BYTES,
  _getKnownHostsCacheState,
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
  rememberGlabKnownHost,
  resolveIssueSource
} from './gitlab-project-ref-resolution'
export type {
  LocalGitExecOptions,
  ProjectRef,
  ResolvedIssueSource
} from './gitlab-project-ref-resolution'
export { parseGlabApiResponse, type GlabApiResponse } from './glab-api-response'

const MAX_CONCURRENT = 4
const concurrencyGate = new IntegrationApiConcurrencyGate(MAX_CONCURRENT)

export function acquire(): Promise<void> {
  return concurrencyGate.acquire()
}

export function release(): void {
  concurrencyGate.release()
}

export async function glabApiWithHeaders(
  args: string[],
  options?: { cwd?: string }
): Promise<GlabApiResponse> {
  const { stdout } = await glabExecFileAsync(['api', '-i', ...args], options)
  return parseGlabApiResponse(stdout)
}
