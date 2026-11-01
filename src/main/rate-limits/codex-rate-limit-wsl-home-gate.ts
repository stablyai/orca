import type { CodexAccountSelectionTarget } from '../../shared/codex-selection-lane'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { CodexRateLimitHomeResolution } from '../codex-accounts/runtime-home-service-types'
import { listWslDistrosAsync } from '../wsl'
import { isWslDistroRunning } from '../wsl-background-distro-gate'

type CodexRateLimitHomeSource = {
  prepareForRateLimitFetch: (target?: CodexAccountSelectionTarget) => CodexRateLimitHomeResolution
}

type WslHomeGateDeps = {
  defaultDistro: () => Promise<string | null>
  isRunning: (distro: string) => Promise<boolean>
}

const defaultDeps: WslHomeGateDeps = {
  defaultDistro: async () => (await listWslDistrosAsync())[0] ?? null,
  isRunning: (distro) => isWslDistroRunning(distro)
}

/**
 * A background quota poll never starts a stopped distro (E9). The distro is resolved once, gated,
 * then pinned for the home lookup, so the probe can't run in a different distro than the one read.
 */
export async function resolveCodexRateLimitHomeUnlessStopped(
  source: CodexRateLimitHomeSource,
  target: CodexAccountSelectionTarget | undefined,
  deps: WslHomeGateDeps = defaultDeps
): Promise<CodexRateLimitHomeResolution> {
  if (target?.runtime !== 'wsl') {
    return source.prepareForRateLimitFetch(target)
  }
  if (process.platform !== 'win32') {
    return { kind: 'skip' }
  }
  const distro = target.wslDistro?.trim() || (await deps.defaultDistro())
  if (!distro || !(await deps.isRunning(distro))) {
    return { kind: 'skip' }
  }
  const resolution = source.prepareForRateLimitFetch({ runtime: 'wsl', wslDistro: distro })
  const home = resolution.kind === 'ready' && resolution.codexHomePath
  const homeDistro = home ? parseWslUncPath(home)?.distro : undefined
  // A home in another distro would boot that one: it was never read.
  return homeDistro && homeDistro.toLowerCase() !== distro.toLowerCase()
    ? { kind: 'skip' }
    : resolution
}
