import { addWslEnvKeys } from '../../wsl-env'
import { extractExecError, parseRetryAfterMs } from '../exec-error'
import { resolveCommand } from './wsl-command-resolution'
import { resolveDefaultWslCliFallback } from './default-wsl-cli-fallback'
import { isHostCommandMissing } from './github-cli-host-fallback'
import { execFileCaptureToTermination } from './exec-file-capture'
import { logHostedCliDeadlineKill } from './hosted-cli-deadline-log'
import type { GitExecOptions } from './git-exec-options'
import { argsLookIdempotent } from './gh-idempotency'
import {
  isTransientGhError,
  sleep,
  GH_RETRY_AFTER_MAX_MS,
  GH_RETRY_DELAYS_MS
} from './gh-retry-policy'

const DEFAULT_GLAB_EXEC_TIMEOUT_MS = 30_000

export type GlabExecOptions = Omit<GitExecOptions, 'cwd'> & {
  cwd?: string
  wslDistro?: string
  idempotent?: boolean
  allowDefaultWslFallback?: boolean
}

/** glab rejects --hostname host:port; use GITLAB_HOST for ported self-hosted instances. */
export function redirectPortedHostnameToEnv(
  args: string[],
  options: GlabExecOptions
): { args: string[]; options: GlabExecOptions } {
  const i = args.indexOf('--hostname')
  if (i === -1 || i + 1 >= args.length) {
    return { args, options }
  }
  const host = args[i + 1]
  if (!/^[^/\s]+:\d+$/.test(host)) {
    return { args, options }
  }
  // Forward GITLAB_HOST through WSLENV so distro calls cannot silently target gitlab.com.
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), GITLAB_HOST: host }
  // WSLENV is inert outside Windows.
  addWslEnvKeys(env, ['GITLAB_HOST'])
  return {
    args: [...args.slice(0, i), ...args.slice(i + 2)],
    options: { ...options, env }
  }
}

export async function glabExecFileAsync(
  args: string[],
  options: GlabExecOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  ;({ args, options } = redirectPortedHostnameToEnv(args, options))
  let resolved = resolveCommand('glab', args, options.cwd, options.wslDistro)
  const timeoutMs = options.timeout ?? DEFAULT_GLAB_EXEC_TIMEOUT_MS
  let lastError: unknown
  let attemptedDefaultWslFallback = false
  for (let attempt = 0; attempt <= GH_RETRY_DELAYS_MS.length; attempt++) {
    try {
      // Kill the whole shim tree so descendants cannot outlive the deadline.
      const { stdout, stderr } = await execFileCaptureToTermination(
        resolved.binary,
        resolved.args,
        {
          cwd: resolved.cwd,
          encoding: (options.encoding ?? 'utf-8') as BufferEncoding,
          maxBuffer: options.maxBuffer,
          timeout: timeoutMs,
          env: options.env,
          signal: options.signal,
          onDeadlineKill: () => logHostedCliDeadlineKill('glab', resolved.binary, args, timeoutMs)
        },
        resolved.termination
      )
      return { stdout: stdout as string, stderr: stderr as string }
    } catch (err) {
      lastError = err
      const { stderr } = extractExecError(err)
      if (
        process.platform === 'win32' &&
        !attemptedDefaultWslFallback &&
        resolved.wsl === null &&
        !options.cwd &&
        !options.wslDistro &&
        options.allowDefaultWslFallback !== false &&
        isHostCommandMissing(err, 'glab')
      ) {
        const wslResolved = await resolveDefaultWslCliFallback('glab', args)
        if (wslResolved) {
          resolved = wslResolved
          attemptedDefaultWslFallback = true
          attempt = -1
          continue
        }
      }
      const isLastAttempt = attempt >= GH_RETRY_DELAYS_MS.length
      // Never retry a write that GitLab may already have applied.
      const idempotent = options.idempotent ?? argsLookIdempotent(args)
      if (idempotent && !isLastAttempt && isTransientGhError(stderr)) {
        const retryAfterMs = parseRetryAfterMs(stderr)
        const delayMs =
          retryAfterMs !== null
            ? Math.min(retryAfterMs, GH_RETRY_AFTER_MAX_MS)
            : GH_RETRY_DELAYS_MS[attempt]
        await sleep(delayMs, options.signal)
        continue
      }
      throw err
    }
  }
  throw lastError
}
