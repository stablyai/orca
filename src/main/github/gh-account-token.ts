/**
 * Resolve a short-lived gh token for a bound account and prepare child env.
 *
 * Why: Part A injects tokens only into the gh child — never process-wide —
 * via `gh auth token --user --hostname`. Tokens are never logged.
 */
import { ghExecFileAsync } from '../git/runner'
import { addWslEnvKeys } from '../../shared/wsl-env'
import {
  ghTokenEnvVarForHost,
  normalizeGhAccountBinding,
  type GhAccountBinding
} from '../../shared/github/account-binding'
import {
  createGhMultiAccountUnsupportedError,
  getGhExecutionHostKey,
  getGhMultiAccountCapability,
  normalizeGhCapabilityTarget,
  type GhCapabilityTarget
} from './gh-capability-state'

const TOKEN_RESOLVE_TIMEOUT_MS = 10_000
const POSITIVE_TTL_MS = 5 * 60_000
const NEGATIVE_TTL_MS = 30_000
const CACHE_MAX_ENTRIES = 128

const AMBIENT_GH_ENV_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_REPO'
] as const

type TokenCacheEntry =
  | { kind: 'positive'; token: string; expiresAt: number }
  | { kind: 'negative'; expiresAt: number }

const tokenCache = new Map<string, TokenCacheEntry>()

function tokenCacheKey(binding: GhAccountBinding, target: GhCapabilityTarget): string {
  return `${getGhExecutionHostKey(target)}\0${binding.host}\0${binding.user}`
}

function isTransientTokenResolveFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const code = 'code' in error ? error.code : undefined
  if (code === 'ETIMEDOUT' || code === 'EAGAIN' || code === 'EBUSY' || code === 'ENOENT') {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  const stderr = 'stderr' in error ? String((error as { stderr?: unknown }).stderr ?? '') : ''
  const text = `${message}\n${stderr}`.toLowerCase()
  return (
    text.includes('etimedout') ||
    text.includes('timed out') ||
    text.includes('timeout') ||
    text.includes('eagain') ||
    text.includes('enoent') ||
    text.includes('command not found') ||
    /(?:^|\s)gh:\s+not found(?:\s|$)/.test(text)
  )
}

function stderrFromUnknown(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error) {
    return String((error as { stderr?: unknown }).stderr ?? '')
  }
  return error instanceof Error ? error.message : String(error ?? '')
}

function pruneTokenCache(now: number): void {
  for (const [key, entry] of tokenCache) {
    if (entry.expiresAt <= now) {
      tokenCache.delete(key)
    }
  }
  while (tokenCache.size > CACHE_MAX_ENTRIES) {
    const oldest = tokenCache.keys().next().value
    if (oldest === undefined) {
      return
    }
    tokenCache.delete(oldest)
  }
}

export function createGhBoundAccountUnavailableError(
  binding: GhAccountBinding
): Error & { code: 'gh_bound_account_unavailable'; stderr: string } {
  const message = `Bound GitHub account ${binding.user}@${binding.host} is unavailable on this runtime.`
  return Object.assign(new Error(message), {
    code: 'gh_bound_account_unavailable' as const,
    stderr: message
  })
}

export function createGhBoundAccountHostMismatchError(
  binding: GhAccountBinding,
  host: string | undefined
): Error & { code: 'gh_bound_account_host_mismatch'; stderr: string } {
  const message = host
    ? `Bound GitHub account host ${binding.host} does not match request host ${host}.`
    : `Bound GitHub account ${binding.user}@${binding.host} requires an explicit matching host.`
  return Object.assign(new Error(message), {
    code: 'gh_bound_account_host_mismatch' as const,
    stderr: message
  })
}

/** Resolves a short-lived token for `binding`, cached 5 min positive / 30 s negative per execution host. */
export async function resolveGhAccountToken(
  bindingInput: GhAccountBinding,
  target: GhCapabilityTarget = {},
  nowMs = Date.now()
): Promise<string> {
  const binding = normalizeGhAccountBinding(bindingInput)
  if (!binding) {
    throw createGhBoundAccountUnavailableError({ host: '?', user: '?' })
  }

  const normalizedTarget = normalizeGhCapabilityTarget(target)
  const capability = await getGhMultiAccountCapability(normalizedTarget, nowMs)
  if (capability === 'unsupported') {
    throw createGhMultiAccountUnsupportedError()
  }
  if (capability === 'unknown') {
    throw createGhBoundAccountUnavailableError(binding)
  }

  pruneTokenCache(nowMs)
  const key = tokenCacheKey(binding, normalizedTarget)
  const cached = tokenCache.get(key)
  if (cached && cached.expiresAt > nowMs) {
    if (cached.kind === 'positive') {
      return cached.token
    }
    throw createGhBoundAccountUnavailableError(binding)
  }

  try {
    const resolveEnv = stripAmbientGhTokenEnv(process.env)
    resolveEnv.GH_PROMPT_DISABLED = resolveEnv.GH_PROMPT_DISABLED ?? '1'
    // Why: the command runner is the only sanctioned gh spawn (deadline, tree kill);
    // `auth` argv is exempt from binding, so this cannot recurse.
    const { stdout } = await ghExecFileAsync(
      ['auth', 'token', '--user', binding.user, '--hostname', binding.host],
      {
        cwd: normalizedTarget.cwd,
        wslDistro: normalizedTarget.wslDistro,
        timeout: TOKEN_RESOLVE_TIMEOUT_MS,
        env: resolveEnv
      }
    )
    const token = stdout.replace(/\r?\n/g, '').trim()
    if (!token) {
      // Why: empty token is a stable auth miss — negative-cache to avoid hammering keyring.
      tokenCache.set(key, { kind: 'negative', expiresAt: nowMs + NEGATIVE_TTL_MS })
      pruneTokenCache(nowMs)
      throw createGhBoundAccountUnavailableError(binding)
    }
    tokenCache.set(key, { kind: 'positive', token, expiresAt: nowMs + POSITIVE_TTL_MS })
    pruneTokenCache(nowMs)
    return token
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'gh_bound_account_unavailable' ||
        error.code === 'gh_multi_account_unsupported')
    ) {
      throw error
    }
    const unavailable = createGhBoundAccountUnavailableError(binding)
    const stderr = stderrFromUnknown(error)
    if (stderr) {
      unavailable.stderr = stderr
    }
    // Why: timeouts / missing gh / spawn blips must not poison the cache for 30s.
    if (!isTransientTokenResolveFailure(error)) {
      tokenCache.set(key, { kind: 'negative', expiresAt: nowMs + NEGATIVE_TTL_MS })
      pruneTokenCache(nowMs)
    }
    throw unavailable
  }
}

/** Drops ambient GH_TOKEN/GH_HOST/GH_REPO so a bound call cannot inherit the globally active login. */
export function stripAmbientGhTokenEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  for (const key of AMBIENT_GH_ENV_KEYS) {
    delete next[key]
  }
  return next
}

/** Builds the gh child env with the bound token, registering it in WSLENV when the child runs under wsl.exe. */
export function buildBoundGhChildEnv(args: {
  baseEnv?: NodeJS.ProcessEnv
  binding: GhAccountBinding
  token: string
  /** When true, register token + GH_PROMPT_DISABLED in WSLENV for wsl.exe. */
  forWsl?: boolean
}): NodeJS.ProcessEnv {
  const binding = normalizeGhAccountBinding(args.binding)
  if (!binding) {
    throw createGhBoundAccountUnavailableError({ host: '?', user: '?' })
  }
  const tokenVar = ghTokenEnvVarForHost(binding.host)
  const env = stripAmbientGhTokenEnv(args.baseEnv ?? process.env)
  env.GH_PROMPT_DISABLED = env.GH_PROMPT_DISABLED ?? '1'
  env[tokenVar] = args.token
  if (args.forWsl) {
    addWslEnvKeys(env, [tokenVar, 'GH_PROMPT_DISABLED'])
  }
  return env
}

/** Drops cached tokens for one binding across every execution host; clears the whole cache when omitted. */
export function invalidateGhAccountTokenCache(binding?: GhAccountBinding | null): void {
  if (!binding) {
    tokenCache.clear()
    return
  }
  const normalized = normalizeGhAccountBinding(binding)
  if (!normalized) {
    tokenCache.clear()
    return
  }
  for (const key of tokenCache.keys()) {
    if (key.endsWith(`\0${normalized.host}\0${normalized.user}`)) {
      tokenCache.delete(key)
    }
  }
}

/** @internal — test-only */
export function clearGhAccountTokenCacheForTests(): void {
  tokenCache.clear()
}
