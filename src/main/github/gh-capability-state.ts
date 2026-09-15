/**
 * Per-runtime cache for `gh auth token --user` support (gh ≥ 2.40).
 *
 * Why: binding creation must not offer accounts when the execution host's gh
 * is too old; probe once per local/WSL runtime and recheck after fallbacks.
 */
import { ghExecFileAsync } from '../git/runner'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { GhMultiAccountCapability } from '../../shared/github/auth-types'

export type GhCapabilityTarget = {
  cwd?: string
  wslDistro?: string
}

const CAPABILITY_UNSUPPORTED_RETRY_MS = 30 * 60_000
const CAPABILITY_UNKNOWN_RETRY_MS = 60_000
const CAPABILITY_PROBE_TIMEOUT_MS = 10_000

type CachedCapability = {
  value: GhMultiAccountCapability
  retryAfterMs: number
}

const capabilityByExecutionHost = new Map<string, CachedCapability>()
const probesByExecutionHost = new Map<string, Promise<GhMultiAccountCapability>>()
/** Bumped on invalidate so in-flight probes cannot commit stale results. */
const generationByExecutionHost = new Map<string, number>()

/** Infers the WSL distro from a UNC `cwd` so capability and token probes run on the same host they are cached under. */
export function normalizeGhCapabilityTarget(target: GhCapabilityTarget = {}): GhCapabilityTarget {
  const wslDistro =
    target.wslDistro ?? (target.cwd ? parseWslUncPath(target.cwd)?.distro : undefined)
  return {
    ...(target.cwd ? { cwd: target.cwd } : {}),
    ...(wslDistro ? { wslDistro } : {})
  }
}

/** Cache key isolating native, per-distro WSL, and SSH capability state from each other. */
export function getGhExecutionHostKey(target: GhCapabilityTarget = {}): string {
  const normalized = normalizeGhCapabilityTarget(target)
  return normalized.wslDistro ? `wsl:${normalized.wslDistro}` : 'local'
}

function isNarrowMultiAccountUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const stderr =
    error && typeof error === 'object' && 'stderr' in error
      ? String((error as { stderr?: unknown }).stderr ?? '')
      : ''
  const text = `${message}\n${stderr}`.toLowerCase()
  // Why: only treat option-echo / unknown-flag shapes as unsupported — missing
  // gh, auth failures, and timeouts stay unknown so Settings can Retry.
  return (
    text.includes('unknown flag: --user') ||
    text.includes('unknown command') ||
    (text.includes('auth token') && text.includes('unknown flag'))
  )
}

async function probeMultiAccountCapability(
  target: GhCapabilityTarget
): Promise<GhMultiAccountCapability> {
  const normalized = normalizeGhCapabilityTarget(target)
  try {
    const { stdout, stderr } = await ghExecFileAsync(['auth', 'token', '--help'], {
      cwd: normalized.cwd,
      wslDistro: normalized.wslDistro,
      timeout: CAPABILITY_PROBE_TIMEOUT_MS,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: process.env.GH_PROMPT_DISABLED ?? '1'
      }
    })
    const help = `${stdout}\n${stderr}`
    return help.includes('--user') ? 'supported' : 'unsupported'
  } catch (error) {
    if (isNarrowMultiAccountUnsupported(error)) {
      return 'unsupported'
    }
    return 'unknown'
  }
}

/** Probes `gh auth token --user` support; 'unknown' means the probe itself failed and must not be cached as unsupported. */
export async function getGhMultiAccountCapability(
  target: GhCapabilityTarget = {},
  nowMs = Date.now()
): Promise<GhMultiAccountCapability> {
  const normalized = normalizeGhCapabilityTarget(target)
  const key = getGhExecutionHostKey(normalized)
  const cached = capabilityByExecutionHost.get(key)
  if (cached && nowMs < cached.retryAfterMs) {
    return cached.value
  }
  if (cached && nowMs >= cached.retryAfterMs) {
    capabilityByExecutionHost.delete(key)
  }

  const inFlight = probesByExecutionHost.get(key)
  if (inFlight) {
    return inFlight
  }

  const generation = generationByExecutionHost.get(key) ?? 0
  const probe = probeMultiAccountCapability(normalized).then((value) => {
    if ((generationByExecutionHost.get(key) ?? 0) !== generation) {
      return value
    }
    const retryAfterMs =
      nowMs +
      (value === 'supported'
        ? Number.POSITIVE_INFINITY
        : value === 'unsupported'
          ? CAPABILITY_UNSUPPORTED_RETRY_MS
          : CAPABILITY_UNKNOWN_RETRY_MS)
    capabilityByExecutionHost.set(key, {
      value,
      retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : Number.MAX_SAFE_INTEGER
    })
    return value
  })
  probesByExecutionHost.set(key, probe)
  try {
    return await probe
  } finally {
    if (probesByExecutionHost.get(key) === probe) {
      probesByExecutionHost.delete(key)
    }
  }
}

/** Bumps the generation so a probe already in flight cannot commit its now-stale result. */
export function invalidateGhMultiAccountCapability(target?: GhCapabilityTarget): void {
  if (!target) {
    capabilityByExecutionHost.clear()
    probesByExecutionHost.clear()
    for (const key of generationByExecutionHost.keys()) {
      generationByExecutionHost.set(key, (generationByExecutionHost.get(key) ?? 0) + 1)
    }
    return
  }
  const key = getGhExecutionHostKey(target)
  capabilityByExecutionHost.delete(key)
  probesByExecutionHost.delete(key)
  generationByExecutionHost.set(key, (generationByExecutionHost.get(key) ?? 0) + 1)
}

export function createGhMultiAccountUnsupportedError(): Error & {
  code: 'gh_multi_account_unsupported'
  stderr: string
} {
  const message =
    'This GitHub CLI is too old for per-project account binding (needs gh ≥ 2.40 with `gh auth token --user`).'
  return Object.assign(new Error(message), {
    code: 'gh_multi_account_unsupported' as const,
    stderr: message
  })
}

/** @internal — test-only */
export function clearGhCapabilityStateForTests(): void {
  capabilityByExecutionHost.clear()
  probesByExecutionHost.clear()
  generationByExecutionHost.clear()
}
