import {
  classifyGhRateLimitBucket,
  createGhRateLimitBlockedError,
  getGhRateLimitBlockedUntilMs,
  ghRateLimitScopeKey,
  isGhPrimaryRateLimitStderr,
  isGhLocalOnlyCommand,
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
import { execFileCaptureToTermination } from './exec-file-capture'
import { logHostedCliDeadlineKill } from './hosted-cli-deadline-log'
import type { GitExecOptions } from './git-exec-options'
import { argsLookIdempotent } from './gh-idempotency'
import { applyGhHostToArgs, explicitGhHostname, explicitGhRepoHostname } from './gh-host-args'
import { isGhBoundAccountError, resolveBoundGhExecEnv } from './gh-bound-account-env'
import {
  assertGhCallActive,
  createGhLogicalLifetime,
  type GhCaptureLifetimeHooks
} from './gh-capture-lifetime'
import {
  defaultGhExecTimeoutMs,
  isTransientGhError,
  sleep,
  GH_RETRY_AFTER_MAX_MS,
  GH_RETRY_DELAYS_MS
} from './gh-retry-policy'

// cwd is optional; wslDistro routes global calls when Windows has no host gh binary.
// Retry only idempotent calls: a failed response can follow a completed write.
export type GhExecOptions = Omit<GitExecOptions, 'cwd'> & {
  cwd?: string
  wslDistro?: string
  idempotent?: boolean
  // Pin API/repo shorthand to its host, including GHES, and scope rate-limit state there.
  host?: string
  /** Per-project account binding; the runner resolves and injects a child-only token. */
  ghAccount?: { host: string; user: string }
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
  // Explicit argv hosts determine the actual request and therefore its breaker scope.
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

/** Execute gh with bounded retries for transient failures on idempotent calls. */
export async function ghExecFileAsync(
  args: string[],
  options: GhExecOptions = {},
  lifetimeHooks?: GhCaptureLifetimeHooks
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await ghExecFileWithScopeAsync(args, options, lifetimeHooks)
  return { stdout, stderr }
}

/** Includes the successful runtime's breaker scope after any host/WSL fallback. */
export async function ghExecFileWithScopeAsync(
  args: string[],
  options: GhExecOptions = {},
  lifetimeHooks?: GhCaptureLifetimeHooks
): Promise<{ stdout: string; stderr: string; rateLimitScope: string }> {
  // Why: retry safety must reflect the original call even when fallbacks replace the resolved command.
  const idempotent = options.idempotent ?? argsLookIdempotent(args)
  // Legacy bound calls may omit host; pin it before selecting token variables or qualifying argv.
  if (options.ghAccount && !options.host?.trim() && args[0] !== 'auth') {
    options = { ...options, host: options.ghAccount.host.trim().toLowerCase() }
  }
  args = applyGhHostToArgs(args, options.host)
  let resolved = resolveCommand('gh', args, options.cwd, options.wslDistro)
  // Skip blocked API buckets; exempt reset probes and local token reads, and isolate host/runtime quotas.
  const rateLimitBucket = classifyGhRateLimitBucket(args)
  const rateLimitExempt = isGhRateLimitProbe(args) || isGhLocalOnlyCommand(args)
  let boundEnv: NodeJS.ProcessEnv | undefined = options.env
  let boundEnvResolvedKey: string | null = null
  const boundEnvKeyFor = (command: ResolvedCommand): string =>
    command.wsl ? `wsl:${command.wsl.distro}` : 'native'
  // Preserve synchronous spawning for unbound calls so immediate aborts still have a child to kill.
  const ensureBoundEnv = (hooks?: GhCaptureLifetimeHooks): Promise<void> | null => {
    const key = boundEnvKeyFor(resolved)
    if (boundEnvResolvedKey === key) {
      return null
    }
    if (!options.ghAccount || args[0] === 'auth') {
      boundEnv = options.env
      boundEnvResolvedKey = key
      return null
    }
    return resolveBoundGhExecEnv(options, resolved, args, hooks).then((env) => {
      boundEnv = env
      boundEnvResolvedKey = key
    })
  }
  const timeoutMs = options.timeout ?? defaultGhExecTimeoutMs(options.env)
  assertGhRateLimitScopeAvailable(args, options, resolved, rateLimitBucket, rateLimitExempt)
  let lastError: unknown
  let attemptedHostFallback = false
  let attemptedDefaultWslFallback = false
  // A missing WSL gh can fail during token resolution; fall back and resolve credentials on the new host.
  const tryHostFallbackAfterBoundResolveFailure = (error: unknown): boolean => {
    if (attemptedHostFallback) {
      return false
    }
    const { stderr } = extractExecError(error)
    if (!canFallBackToHostGitHubCli('gh', args, resolved, stderr)) {
      return false
    }
    resolved = resolveHostGitHubCli('gh', args)
    attemptedHostFallback = true
    boundEnvResolvedKey = null
    assertGhRateLimitScopeAvailable(args, options, resolved, rateLimitBucket, rateLimitExempt)
    return true
  }
  for (let attempt = 0; attempt <= GH_RETRY_DELAYS_MS.length; attempt++) {
    const lifetime = lifetimeHooks ? createGhLogicalLifetime(lifetimeHooks) : null
    if (lifetime) {
      lifetimeHooks?.onTerminationPending(lifetime.terminated)
    }
    try {
      if (lifetime) {
        assertGhCallActive(options.signal)
      }
      const boundEnvReady = ensureBoundEnv(lifetime?.hooks)
      if (boundEnvReady) {
        await boundEnvReady
        // Why: the breaker may have tripped while the token resolved.
        assertGhRateLimitScopeAvailable(args, options, resolved, rateLimitBucket, rateLimitExempt)
      }
      if (lifetime) {
        await lifetime.waitPending(options.signal)
      }
      // gh may be a shim chain; terminate the whole tree so descendants cannot outlive the deadline.
      const { stdout, stderr } = await execFileCaptureToTermination(
        resolved.binary,
        resolved.args,
        {
          cwd: resolved.cwd,
          encoding: (options.encoding ?? 'utf-8') as BufferEncoding,
          maxBuffer: options.maxBuffer,
          timeout: timeoutMs,
          env: nonInteractiveGhEnv(boundEnv ?? options.env),
          signal: options.signal,
          stdin: options.stdin,
          onChildTerminated: lifetime?.capture(),
          onDeadlineKill: () => logHostedCliDeadlineKill('gh', resolved.binary, args, timeoutMs)
        },
        resolved.termination
      )
      if (lifetime) {
        await lifetime.waitPending(options.signal)
      }
      return {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Capture decodes stdout with the requested string encoding above.
        stdout: stdout as string,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Capture decodes stderr with the requested string encoding above.
        stderr: stderr as string,
        rateLimitScope: ghRateLimitScope(args, options, resolved)
      }
    } catch (err) {
      if (lifetime) {
        try {
          await lifetime.waitPending(options.signal)
        } catch (waitError) {
          if (!options.signal?.aborted) {
            throw err
          }
          if (
            waitError instanceof Error &&
            err &&
            typeof err === 'object' &&
            'outputTruncated' in err &&
            typeof err.outputTruncated === 'boolean'
          ) {
            Object.assign(waitError, { outputTruncated: err.outputTruncated })
          }
          throw waitError
        }
      }
      lastError = err
      if (isGhBoundAccountError(err)) {
        if (tryHostFallbackAfterBoundResolveFailure(err)) {
          attempt = -1
          continue
        }
        throw err
      }
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
          // Global calls have no cwd to route WSL-only Windows installs.
          resolved = wslResolved
          attemptedDefaultWslFallback = true
          // Resolve the token again on the new execution host.
          boundEnvResolvedKey = null
          assertGhRateLimitScopeAvailable(args, options, resolved, rateLimitBucket, rateLimitExempt)
          attempt = -1
          continue
        }
      }
      if (!attemptedHostFallback && canFallBackToHostGitHubCli('gh', args, resolved, stderr)) {
        resolved = resolveHostGitHubCli('gh', args)
        attemptedHostFallback = true
        // Resolve the token again on the new execution host.
        boundEnvResolvedKey = null
        assertGhRateLimitScopeAvailable(args, options, resolved, rateLimitBucket, rateLimitExempt)
        attempt = -1
        continue
      }
      const isLastAttempt = attempt >= GH_RETRY_DELAYS_MS.length
      if (idempotent && !isLastAttempt && isTransientGhError(stderr)) {
        // Honor Retry-After, capped to keep IPC bounded.
        const retryAfterMs = parseRetryAfterMs(stderr)
        const delayMs =
          retryAfterMs !== null
            ? Math.min(retryAfterMs, GH_RETRY_AFTER_MAX_MS)
            : GH_RETRY_DELAYS_MS[attempt]
        await sleep(delayMs, options.signal)
        continue
      }
      throw err
    } finally {
      lifetime?.seal()
    }
  }
  throw lastError
}
