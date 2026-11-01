import { ghExecFileAsync } from '../../gh-utils'
import type { GitHubApiRepository } from '../../github-api-repository'
import type { GhExecOptions } from '../github-exec-scope'
import { createGhLogicalLifetime } from '../../../git/command-runner/gh-capture-lifetime'
import type { GhCaptureLifetimeHooks } from '../../../git/command-runner/gh-capture-lifetime'
import { runCheckDetailsCall } from './check-details-admission-lifetime'
import { createCheckDetailsAbortError, waitForCheckDetailsResolution } from './check-details-abort'

export const PR_CHECK_LOG_MAX_BUFFER = 64 * 1024 * 1024
const ESCAPE_FLAG = '--allow-escape-sequences'

function ownField(error: unknown, name: string): unknown {
  if (!error || typeof error !== 'object') {
    return undefined
  }
  const descriptor = Object.getOwnPropertyDescriptor(error, name)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

function isUnsupportedCheckLogEscapeFlag(
  error: unknown,
  signal: AbortSignal,
  deadlineAt: number
): boolean {
  const code = ownField(error, 'code')
  if (
    ownField(error, 'outputTruncated') === true ||
    code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
    code === 'ENOBUFS'
  ) {
    return false
  }
  if (
    signal.aborted ||
    Date.now() >= deadlineAt ||
    ownField(error, 'name') === 'AbortError' ||
    ['ABORT_ERR', 'ERR_ABORTED', 'ETIMEDOUT'].includes(typeof code === 'string' ? code : '') ||
    ownField(error, 'timedOut') === true ||
    ownField(error, 'killed') === true ||
    (ownField(error, 'signal') !== undefined && ownField(error, 'signal') !== null)
  ) {
    return false
  }
  if (typeof code !== 'number' || !Number.isFinite(code) || code === 0) {
    return false
  }
  const captured = ownField(error, 'stderr')
  const stderr =
    typeof captured === 'string'
      ? captured
      : Buffer.isBuffer(captured)
        ? captured.toString('utf8')
        : null
  // Identical unlabelled response lines are indistinguishable from parser output.
  return (
    stderr !== null &&
    stderr.split(/\r\n|\r|\n/).some((line) => line === `unknown flag: ${ESCAPE_FLAG}`)
  )
}

export function assertCheckLogActive(signal: AbortSignal, deadlineAt: number): void {
  if (signal.aborted || Date.now() >= deadlineAt) {
    throw createCheckDetailsAbortError()
  }
}

async function fetchCheckJobLog(
  ownerRepo: GitHubApiRepository,
  jobId: number,
  options: GhExecOptions & { signal: AbortSignal },
  deadlineAt: number,
  hooks: GhCaptureLifetimeHooks
): Promise<string> {
  const argv = ['api', `repos/${ownerRepo.owner}/${ownerRepo.repo}/actions/jobs/${jobId}/logs`]
  const attempt = async (flagged: boolean): Promise<string> => {
    assertCheckLogActive(options.signal, deadlineAt)
    const lifetime = createGhLogicalLifetime(hooks)
    const result = ghExecFileAsync(
      flagged ? [...argv, ESCAPE_FLAG] : argv,
      {
        ...options,
        maxBuffer: PR_CHECK_LOG_MAX_BUFFER,
        timeout: deadlineAt - Date.now()
      },
      lifetime.hooks
    ).then(
      (value) => {
        lifetime.seal()
        return value
      },
      (error: unknown) => {
        lifetime.seal()
        throw error
      }
    )
    try {
      const { stdout } = await result
      await waitForCheckDetailsResolution(lifetime.terminated, options.signal)
      assertCheckLogActive(options.signal, deadlineAt)
      return stdout
    } catch (error) {
      await waitForCheckDetailsResolution(lifetime.terminated, options.signal)
      throw error
    }
  }
  try {
    return await attempt(true)
  } catch (error) {
    if (!isUnsupportedCheckLogEscapeFlag(error, options.signal, deadlineAt)) {
      throw error
    }
    assertCheckLogActive(options.signal, deadlineAt)
    return attempt(false)
  }
}

export function startCheckJobLogDownload(
  ownerRepo: GitHubApiRepository,
  jobId: number,
  options: GhExecOptions & { signal: AbortSignal },
  deadlineAt: number,
  retainUntil: (terminated: Promise<void>) => void
): { result: Promise<string>; terminated: Promise<void> } {
  return runCheckDetailsCall(
    (hooks) => fetchCheckJobLog(ownerRepo, jobId, options, deadlineAt, hooks),
    options.signal,
    retainUntil
  )
}
