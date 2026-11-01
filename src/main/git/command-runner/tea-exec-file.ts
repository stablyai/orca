import { addWslEnvKeys } from '../../../shared/wsl-env'
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

const DEFAULT_TEA_EXEC_TIMEOUT_MS = 30_000

export type TeaExecOptions = Omit<GitExecOptions, 'cwd'> & {
  cwd?: string
  wslDistro?: string
  idempotent?: boolean
  allowDefaultWslFallback?: boolean
}

/** tea reads GITEA_*; Orca's existing credential env uses the ORCA_GITEA_* names. */
function teaProcessEnv(options: TeaExecOptions): NodeJS.ProcessEnv | undefined {
  const base = options.env ?? process.env
  const token = base.GITEA_TOKEN || base.ORCA_GITEA_TOKEN
  const instanceUrl = base.GITEA_INSTANCE_URL || base.ORCA_GITEA_API_BASE_URL
  const mapsOrcaNames =
    (!base.GITEA_TOKEN && Boolean(base.ORCA_GITEA_TOKEN)) ||
    (!base.GITEA_INSTANCE_URL && Boolean(base.ORCA_GITEA_API_BASE_URL))
  const forwardsToWsl = process.platform === 'win32' && Boolean(token || instanceUrl)
  if (!options.env && !mapsOrcaNames && !forwardsToWsl) {
    return undefined
  }
  const env: NodeJS.ProcessEnv = { ...base }
  if (!env.GITEA_TOKEN && token) {
    env.GITEA_TOKEN = token
  }
  if (!env.GITEA_INSTANCE_URL && instanceUrl) {
    env.GITEA_INSTANCE_URL = instanceUrl
  }
  if (process.platform === 'win32') {
    const keys = ['GITEA_INSTANCE_URL', 'GITEA_TOKEN'].filter((key) => env[key])
    if (keys.length > 0) {
      // WSLENV is inert outside Windows; listing the keys lets a distro tea see host credentials.
      addWslEnvKeys(env, keys)
    }
  }
  return env
}

export async function teaExecFileAsync(
  args: string[],
  options: TeaExecOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const env = teaProcessEnv(options)
  const stdin = options.stdin ?? ''
  let resolved = resolveCommand('tea', args, options.cwd, options.wslDistro)
  const timeoutMs = options.timeout ?? DEFAULT_TEA_EXEC_TIMEOUT_MS
  let lastError: unknown
  let attemptedDefaultWslFallback = false
  for (let attempt = 0; attempt <= GH_RETRY_DELAYS_MS.length; attempt++) {
    try {
      // Kill the whole shim tree so descendants cannot outlive the deadline.
      const encoding = options.encoding === 'buffer' ? 'utf-8' : (options.encoding ?? 'utf-8')
      const { stdout, stderr } = await execFileCaptureToTermination(
        resolved.binary,
        resolved.args,
        {
          cwd: resolved.cwd,
          encoding,
          maxBuffer: options.maxBuffer,
          timeout: timeoutMs,
          env,
          stdin,
          signal: options.signal,
          onDeadlineKill: () => logHostedCliDeadlineKill('tea', resolved.binary, args, timeoutMs)
        },
        resolved.termination
      )
      if (typeof stdout !== 'string' || typeof stderr !== 'string') {
        throw new Error('tea exec returned non-text output')
      }
      return { stdout, stderr }
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
        isHostCommandMissing(err, 'tea')
      ) {
        const wslResolved = await resolveDefaultWslCliFallback('tea', args)
        if (wslResolved) {
          resolved = wslResolved
          attemptedDefaultWslFallback = true
          attempt = -1
          continue
        }
      }
      const isLastAttempt = attempt >= GH_RETRY_DELAYS_MS.length
      // Never retry a write that Gitea may already have applied.
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
