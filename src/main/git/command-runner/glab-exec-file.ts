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

export function glabExecFileAsync(
  args: string[],
  options: GlabExecOptions & { encoding: 'buffer' }
): Promise<{ stdout: Buffer; stderr: Buffer }>
export function glabExecFileAsync(
  args: string[],
  options?: GlabExecOptions
): Promise<{ stdout: string; stderr: string }>
export async function glabExecFileAsync(
  args: string[],
  options: GlabExecOptions = {}
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  ;({ args, options } = redirectPortedHostnameToEnv(args, options))
  let resolved = resolveCommand('glab', args, options.cwd, options.wslDistro)
  const timeoutMs = options.timeout ?? DEFAULT_GLAB_EXEC_TIMEOUT_MS
  let lastError: unknown
  let attemptedDefaultWslFallback = false
  for (let attempt = 0; attempt <= GH_RETRY_DELAYS_MS.length; attempt++) {
    try {
      // Both text and binary commands retain the shim termination barrier (#18234).
      const captureOptions: Parameters<typeof execFileCaptureToTermination>[2] = {
        cwd: resolved.cwd,
        encoding: options.encoding ?? 'utf-8',
        maxBuffer: options.maxBuffer,
        timeout: timeoutMs,
        env: options.env,
        signal: options.signal,
        onDeadlineKill: () => logHostedCliDeadlineKill('glab', resolved.binary, args, timeoutMs)
      }
      const { stdout, stderr } = await execFileCaptureToTermination(
        resolved.binary,
        resolved.args,
        captureOptions,
        resolved.termination
      )
      if (options.encoding === 'buffer') {
        if (!Buffer.isBuffer(stdout) || !Buffer.isBuffer(stderr)) {
          throw new Error('glab binary capture returned decoded text')
        }
        return { stdout, stderr }
      }
      return {
        stdout: typeof stdout === 'string' ? stdout : stdout.toString(options.encoding ?? 'utf-8'),
        stderr: typeof stderr === 'string' ? stderr : stderr.toString(options.encoding ?? 'utf-8')
      }
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
