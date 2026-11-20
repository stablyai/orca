import { addWslEnvKeys } from '../../../../shared/shell/wsl/wsl-env'
import { withConfiguredProxyEnv } from '../../../network/configured-proxy-child-env'
import { extractExecError, parseRetryAfterMs } from '../process-capture/exec-error'
import { resolveCommand } from '../host-routing/wsl-command-resolution'
import { resolveDefaultWslCliFallback } from './default-wsl-cli-fallback'
import { isHostCommandMissing } from './github-cli-host-fallback'
import { execFileCaptureToTermination } from '../process-capture/exec-file-capture'
import { logHostedCliDeadlineKill } from './hosted-cli-deadline-log'
import type { GitExecOptions } from '../git-exec-options'
import { argsLookIdempotent } from './gh-idempotency'
import {
  isTransientGhError,
  sleep,
  GH_RETRY_AFTER_MAX_MS,
  GH_RETRY_DELAYS_MS
} from './gh-retry-policy'

const DEFAULT_GT_EXEC_TIMEOUT_MS = 30_000

export type GtExecOptions = Omit<GitExecOptions, 'cwd'> & {
  cwd?: string
  wslDistro?: string
  idempotent?: boolean
  allowDefaultWslFallback?: boolean
  host?: string
  repo?: string
}

function hasArg(args: readonly string[], flag: string, shortFlag?: string): boolean {
  return args.some(
    (arg) =>
      arg === flag ||
      arg.startsWith(`${flag}=`) ||
      (shortFlag !== undefined && (arg === shortFlag || arg.startsWith(`${shortFlag}=`)))
  )
}

function decorateGtArgs(args: string[], options: GtExecOptions): string[] {
  const decorated = [...args]
  if (options.host && !hasArg(decorated, '--host')) {
    decorated.unshift('--host', options.host)
  }
  if (options.repo && !hasArg(decorated, '--repo', '-R')) {
    decorated.unshift('--repo', options.repo)
  }
  return decorated
}

/** gt reads GITEA_*; Orca's credential env uses the ORCA_GITEA_* names. */
function gtProcessEnv(options: GtExecOptions): NodeJS.ProcessEnv {
  const base = withConfiguredProxyEnv(options.env) ?? options.env ?? process.env
  const token = base.GITEA_TOKEN || base.ORCA_GITEA_TOKEN
  const instanceUrl = base.GITEA_CLI_HOST || base.GITEA_INSTANCE_URL || base.ORCA_GITEA_API_BASE_URL
  const env: NodeJS.ProcessEnv = {
    ...base,
    NO_COLOR: '1',
    GITEA_CLI_ERROR_FORMAT: 'json',
    GITEA_CLI_NO_UPDATE_NOTIFIER: '1',
    GITEA_CLI_NO_EXTENSIONS: '1'
  }
  if (!env.GITEA_TOKEN && token) {
    env.GITEA_TOKEN = token
  }
  if (!env.GITEA_CLI_HOST && instanceUrl) {
    env.GITEA_CLI_HOST = instanceUrl
  }
  if (!env.GITEA_INSTANCE_URL && instanceUrl) {
    env.GITEA_INSTANCE_URL = instanceUrl
  }
  if (process.platform === 'win32') {
    const keys = [
      'GITEA_TOKEN',
      'GITEA_CLI_HOST',
      'GITEA_INSTANCE_URL',
      'GITEA_CLI_ERROR_FORMAT',
      'GITEA_CLI_NO_UPDATE_NOTIFIER',
      'GITEA_CLI_NO_EXTENSIONS',
      'NO_COLOR'
    ].filter((key) => env[key])
    if (keys.length > 0) {
      addWslEnvKeys(env, keys)
    }
  }
  return env
}

export async function gtExecFileAsync(
  args: string[],
  options: GtExecOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const decoratedArgs = decorateGtArgs(args, options)
  const env = gtProcessEnv(options)
  const stdin = options.stdin ?? ''
  let resolved = resolveCommand('gt', decoratedArgs, options.cwd, options.wslDistro)
  const timeoutMs = options.timeout ?? DEFAULT_GT_EXEC_TIMEOUT_MS
  let lastError: unknown
  let attemptedDefaultWslFallback = false
  for (let attempt = 0; attempt <= GH_RETRY_DELAYS_MS.length; attempt++) {
    try {
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
          onDeadlineKill: () =>
            logHostedCliDeadlineKill('gt', resolved.binary, decoratedArgs, timeoutMs)
        },
        resolved.termination
      )
      if (typeof stdout !== 'string' || typeof stderr !== 'string') {
        throw new Error('gt exec returned non-text output')
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
        isHostCommandMissing(err, 'gt')
      ) {
        const wslResolved = await resolveDefaultWslCliFallback('gt', decoratedArgs)
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
