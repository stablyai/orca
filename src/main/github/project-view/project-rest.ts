import { acquire, release } from '../execution/github-operation-slots'
import { extractExecError } from '../../git/command-runner/process-capture/exec-error'
import { ghExecFileAsync } from '../../git/command-runner/hosted-cli/gh-exec-file'
import {
  repositoryRateLimitGuard,
  noteRepositoryRateLimitSpend,
  type RateLimitBucketKind
} from '../api/rate-limit'
import type { GitHubProjectViewError } from '../../../shared/github/projects/project-result-types'
import { classifyProjectError, rateLimitedError } from './project-error-classification'
import { projectHostAuthenticationError } from './project-host-execution'

export async function runRest<T>(
  args: string[],
  cwd?: string,
  bucket: RateLimitBucketKind = 'core',
  options?: { expectEmpty?: boolean; host?: string }
): Promise<{ ok: true; data: T } | { ok: false; error: GitHubProjectViewError }> {
  const authError = await projectHostAuthenticationError(options?.host)
  if (authError) {
    return { ok: false, error: authError }
  }
  // Enterprise traffic has separate quota from the shared github.com snapshot.
  const guard = repositoryRateLimitGuard({ host: options?.host }, bucket)
  if (guard.blocked) {
    return { ok: false, error: rateLimitedError(guard) }
  }
  await acquire()
  noteRepositoryRateLimitSpend({ host: options?.host }, bucket)
  try {
    const { stdout, stderr } = await ghExecFileAsync(['api', ...args], {
      encoding: 'utf-8',
      ...(cwd ? { cwd } : {}),
      ...(options?.host ? { host: options.host } : {})
    })
    // Successful DELETE endpoints can return no body; do not misclassify empty stdout as a parse failure.
    if (options?.expectEmpty && stdout.trim() === '') {
      return { ok: true, data: undefined as T }
    }
    try {
      return { ok: true, data: JSON.parse(stdout) as T }
    } catch {
      return {
        ok: false,
        error: {
          type: 'unknown',
          message: `Unexpected REST response: ${stderr.trim()}`,
          reason: 'unexpected_rest_response',
          detail: stderr.trim()
        }
      }
    }
  } catch (err) {
    const { stderr, stdout: maybeStdout } = extractExecError(err)
    return { ok: false, error: classifyProjectError(stderr, maybeStdout, options?.host) }
  } finally {
    release()
  }
}
