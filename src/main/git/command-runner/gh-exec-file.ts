import {
  classifyGhRateLimitBucket,
  createGhRateLimitBlockedError,
  getGhRateLimitBlockedUntilMs,
  ghRateLimitScopeKey,
  isGhPrimaryRateLimitStderr,
  isGhRateLimitProbe,
  notifyGhPrimaryRateLimit,
  type GhRateLimitBucket
} from '../gh-rate-limit-breaker'
import { extractExecError, parseRetryAfterMs } from '../exec-error'
import {
  resolveCommand,
  resolveDefaultWslCli,
  type ResolvedCommand
} from './wsl-command-resolution'
import {
  canFallBackToHostGitHubCli,
  isHostCommandMissing,
  resolveHostGitHubCli
} from './github-cli-host-fallback'
import { execFileCapture } from './exec-file-capture'
import type { GitExecOptions } from './git-exec-options'
import { argsLookIdempotent } from './gh-idempotency'
import { applyGhHostToArgs, explicitGhHostname, explicitGhRepoHostname } from './gh-host-args'
import {
  defaultGhExecTimeoutMs,
  isTransientGhError,
  sleep,
  GH_RETRY_AFTER_MAX_MS,
  GH_RETRY_DELAYS_MS
} from './gh-retry-policy'

// `cwd?` omitted for non-repo-scoped gh calls (rate_limit, listAccessibleProjects) so one WSL-aware wrapper serves both.
// `wslDistro?` routes global cwd-less gh through `wsl.exe -d <distro>` on WSL-only Windows where gh.exe isn't on host PATH.
// `idempotent?` gates transient-error retry (auto-detected from argv); retrying a write that already reached GitHub would duplicate it.
export type GhExecOptions = Omit<GitExecOptions, 'cwd'> & {
  cwd?: string
  wslDistro?: string
  idempotent?: boolean
  // Why: `gh api` and `--repo OWNER/REPO` shorthand resolve against gh's
  // default host, not the repo's remote. Carrying the host here lets the
  // runner qualify every spawn once, so call sites can't silently fall back
  // to github.com for GHES repos; it also scopes the rate-limit breaker.
  host?: string
}

function nonInteractiveGhEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    GH_PROMPT_DISABLED: env.GH_PROMPT_DISABLED ?? '1'
  }
}

function ghRateLimitScope(
  args: readonly string[],
  options: GhExecOptions,
  resolved: ResolvedCommand
): string {
  const runtime = resolved.wsl ? `wsl:${resolved.wsl.distro.toLowerCase()}` : 'native'
  // Why: an explicit argv hostname controls the actual gh request even when
  // GH_HOST or options.host disagree, so breaker state must follow that host.
  const host =
    explicitGhHostname(args) ??
    options.host ??
    explicitGhRepoHostname(args) ??
    options.env?.GH_HOST ??
    process.env.GH_HOST ??
    'github.com'
  return ghRateLimitScopeKey(runtime, host)
}

function assertGhRateLimitScopeAvailable(
  args: readonly string[],
  options: GhExecOptions,
  resolved: ResolvedCommand,
  bucket: GhRateLimitBucket,
  exemptProbe: boolean
): void {
  if (exemptProbe) {
    return
  }
  const blockedUntilMs = getGhRateLimitBlockedUntilMs(
    bucket,
    Date.now(),
    ghRateLimitScope(args, options, resolved)
  )
  if (blockedUntilMs !== null) {
    throw createGhRateLimitBlockedError(bucket, blockedUntilMs)
  }
}

/**
 * Async gh CLI execution. Drop-in replacement for
 * `execFileAsync('gh', args, { cwd, encoding, ... })`.
 *
 * Retries transient 5xx / 429-without-Retry-After / network-reset failures with
 * exponential backoff; other errors fail fast.
 */
export async function ghExecFileAsync(
  args: string[],
  options: GhExecOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  // Why: retry safety must reflect the original call even when fallbacks replace the resolved command.
  const idempotent = options.idempotent ?? argsLookIdempotent(args)
  args = applyGhHostToArgs(args, options.host)
  let resolved = resolveCommand('gh', args, options.cwd, options.wslDistro)
  // Why: while a bucket is rate-limited every spawn returns 403 — fail fast; the probe is exempt so the breaker can learn the reset.
  // Why: scope by runtime and host so unrelated github.com, GHES, and WSL quotas cannot block each other.
  const rateLimitBucket = classifyGhRateLimitBucket(args)
  const rateLimitProbe = isGhRateLimitProbe(args)
  assertGhRateLimitScopeAvailable(args, options, resolved, rateLimitBucket, rateLimitProbe)
  let lastError: unknown
  let attemptedHostFallback = false
  let attemptedDefaultWslFallback = false
  for (let attempt = 0; attempt <= GH_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const { stdout, stderr } = await execFileCapture(resolved.binary, resolved.args, {
        cwd: resolved.cwd,
        encoding: (options.encoding ?? 'utf-8') as BufferEncoding,
        maxBuffer: options.maxBuffer,
        // Why: bound gh so one stuck child fails visibly instead of wedging the IPC lane.
        timeout: options.timeout ?? defaultGhExecTimeoutMs(options.env),
        env: nonInteractiveGhEnv(options.env),
        signal: options.signal
      })
      return { stdout: stdout as string, stderr: stderr as string }
    } catch (err) {
      lastError = err
      const { stderr } = extractExecError(err)
      if (isGhPrimaryRateLimitStderr(stderr)) {
        notifyGhPrimaryRateLimit(rateLimitBucket, ghRateLimitScope(args, options, resolved))
      }
      if (
        process.platform === 'win32' &&
        !attemptedDefaultWslFallback &&
        resolved.wsl === null &&
        !options.cwd &&
        !options.wslDistro &&
        isHostCommandMissing(err, 'gh')
      ) {
        const wslResolved = resolveDefaultWslCli('gh', args)
        if (wslResolved) {
          // Why: WSL-only Windows installs have no host gh.exe, and global calls (rate_limit/auth) carry no cwd to route by.
          resolved = wslResolved
          attemptedDefaultWslFallback = true
          assertGhRateLimitScopeAvailable(args, options, resolved, rateLimitBucket, rateLimitProbe)
          attempt = -1
          continue
        }
      }
      if (!attemptedHostFallback && canFallBackToHostGitHubCli('gh', args, resolved, stderr)) {
        resolved = resolveHostGitHubCli('gh', args)
        attemptedHostFallback = true
        assertGhRateLimitScopeAvailable(args, options, resolved, rateLimitBucket, rateLimitProbe)
        attempt = -1
        continue
      }
      const isLastAttempt = attempt >= GH_RETRY_DELAYS_MS.length
      if (idempotent && !isLastAttempt && isTransientGhError(stderr)) {
        // Why: honor the server's Retry-After over our backoff (a shorter sleep just re-fails); cap so a huge hint can't stall IPC.
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
  // Unreachable: the loop either returns or throws. Here for TS exhaustiveness.
  throw lastError
}
