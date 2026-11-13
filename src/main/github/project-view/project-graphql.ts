import { acquire, release } from '../execution/github-operation-slots'
import { extractExecError } from '../../git/command-runner/process-capture/exec-error'
import { ghExecFileAsync } from '../../git/command-runner/hosted-cli/gh-exec-file'
import { repositoryRateLimitGuard, noteRepositoryRateLimitSpend } from '../api/rate-limit'
import type { GitHubProjectViewError } from '../../../shared/github/projects/project-result-types'
import {
  classifyProjectError,
  driftError,
  rateLimitedError,
  type GhGraphqlError
} from './project-error-classification'
import { type ProjectGhExecOptions, projectHostAuthenticationError } from './project-host-execution'

export type GraphqlVars = Record<string, string | number | boolean>

export async function runGraphql<T>(
  query: string,
  vars: GraphqlVars,
  exec?: ProjectGhExecOptions
): Promise<
  | { ok: true; data: T }
  | { ok: false; error: GitHubProjectViewError; raw: { stderr: string; stdout: string } }
> {
  const authError = await projectHostAuthenticationError(exec?.host)
  if (authError) {
    return { ok: false, error: authError, raw: { stderr: '', stdout: '' } }
  }
  // Enterprise traffic has separate quota from the shared github.com snapshot.
  const guard = repositoryRateLimitGuard({ host: exec?.host }, 'graphql')
  if (guard.blocked) {
    return { ok: false, error: rateLimitedError(guard), raw: { stderr: '', stdout: '' } }
  }
  // Use typed -F for numbers/booleans and literal -f for strings, including empty strings.
  const args: string[] = ['api', 'graphql', '-f', `query=${query}`]
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === 'number' || typeof v === 'boolean') {
      args.push('-F', `${k}=${String(v)}`)
    } else {
      args.push('-f', `${k}=${v}`)
    }
  }
  await acquire()
  noteRepositoryRateLimitSpend({ host: exec?.host }, 'graphql')
  try {
    const { stdout, stderr } = await ghExecFileAsync(args, {
      encoding: 'utf-8',
      ...(exec?.cwd ? { cwd: exec.cwd } : {}),
      ...(exec?.host ? { host: exec.host } : {})
    })
    try {
      const parsed: { data?: T; errors?: GhGraphqlError[] } = JSON.parse(stdout)
      if (parsed.errors && parsed.errors.length > 0) {
        return {
          ok: false,
          error: classifyProjectError(stderr, stdout, exec?.host),
          raw: { stderr, stdout }
        }
      }
      if (parsed.data === undefined) {
        return {
          ok: false,
          error: driftError('response missing data'),
          raw: { stderr, stdout }
        }
      }
      return { ok: true, data: parsed.data }
    } catch (parseErr) {
      return {
        ok: false,
        error: driftError(
          `failed to parse response (${parseErr instanceof Error ? parseErr.message : String(parseErr)})`
        ),
        raw: { stderr, stdout }
      }
    }
  } catch (err) {
    // Explicit streams preserve diagnostics that Error.message may truncate.
    const { stderr, stdout: maybeStdout } = extractExecError(err)
    return {
      ok: false,
      error: classifyProjectError(stderr, maybeStdout, exec?.host),
      raw: { stderr, stdout: maybeStdout }
    }
  } finally {
    release()
  }
}
