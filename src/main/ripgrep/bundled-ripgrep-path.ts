import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { quotePosixShell } from '../../shared/wsl-login-shell-command'
import {
  BUNDLED_RIPGREP_PACKAGE_BIN_DIR,
  BUNDLED_RIPGREP_RESOURCE_DIR,
  bundledRipgrepBinaryName,
  toBundledRipgrepPlatform,
  type BundledRipgrepPlatform
} from '../../shared/bundled-ripgrep'

/** Only unpackaged dev/test hosts may fall back to this; see bundledRipgrepCommand. */
const PATH_RIPGREP_COMMAND = 'rg'

const resolvedPaths = new Map<BundledRipgrepPlatform, string | null>()
const contentKeys = new Map<BundledRipgrepPlatform, string | null>()

function isPackagedApp(): boolean {
  return hasAppEnvironment() && getAppEnvironment().isPackaged()
}

/** `platform` is a `<os>-<arch>` label; an unbundled one still names where rg would live. */
function candidatePaths(platform: string): string[] {
  const binaryName = bundledRipgrepBinaryName(platform)
  const candidates: string[] = []
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, BUNDLED_RIPGREP_RESOURCE_DIR, platform, binaryName))
  }
  // Why nothing else: a packaged app must never run a binary from whatever checkout it was launched in.
  if (isPackagedApp()) {
    // Why: plain-Node orcad has no resourcesPath; its build copies rg into its own install root.
    candidates.push(
      join(getAppEnvironment().getAppPath(), BUNDLED_RIPGREP_RESOURCE_DIR, platform, binaryName)
    )
    return candidates
  }
  // Why: development and test hosts run from a checkout where only node_modules holds the binaries.
  const roots = [hasAppEnvironment() ? getAppEnvironment().getAppPath() : null, process.cwd()]
  for (const root of roots) {
    if (root) {
      candidates.push(join(root, BUNDLED_RIPGREP_PACKAGE_BIN_DIR, platform, binaryName))
    }
  }
  return candidates
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

// Why never throw: the key only gates the SSH upload, which must not break relay deploy.
function hashBinary(binaryPath: string | null): string | null {
  if (!binaryPath) {
    return null
  }
  try {
    return createHash('sha256').update(readFileSync(binaryPath)).digest('hex').slice(0, 16)
  } catch {
    return null
  }
}

/** Absolute path to Orca's own ripgrep for `platform`, or null when this install lacks it. */
export function resolveBundledRipgrepPath(platform: BundledRipgrepPlatform): string | null {
  if (!resolvedPaths.has(platform)) {
    const found = candidatePaths(platform).find((path) => existsSync(path))
    // Why realpath: dev checkouts reach the package through pnpm symlinks, which SSH uploads reject.
    resolvedPaths.set(platform, found ? realpathOrSelf(found) : null)
  }
  return resolvedPaths.get(platform) ?? null
}

/**
 * The rg command for a local spawn: this host's bundled binary, or its Linux build when the
 * spawn is routed into WSL. Falls back to PATH `rg` only in unpackaged dev/test hosts.
 */
export function bundledRipgrepCommand(options: { wsl?: boolean } = {}): string {
  const os = options.wsl ? 'linux' : process.platform
  const platform = toBundledRipgrepPlatform(os, process.arch)
  const resolved = platform ? resolveBundledRipgrepPath(platform) : null
  if (resolved) {
    return resolved
  }
  if (!isPackagedApp()) {
    return PATH_RIPGREP_COMMAND
  }
  // Why the expected path, not bare 'rg': Windows resolves a bare name in the spawn cwd (the repo)
  // first, so a damaged packaged install must fail with ENOENT instead of running a planted rg.exe.
  // Why this covers an arch we do not bundle too: it has no candidate of its own, but naming where
  // rg would have lived keeps a packaged app from ever handing a bare name to spawn.
  return candidatePaths(platform ?? `${os}-${process.arch}`)[0] ?? PATH_RIPGREP_COMMAND
}

/**
 * Spawn options for a WSL-routed rg: inside the distro, pick the Linux build matching its own
 * architecture (Windows-on-ARM runs x64 Orca beside arm64 distros) from the Windows install via
 * wslpath (custom automount roots). An inaccessible install fails through the missing-tool path.
 */
export function bundledRipgrepWslSpawnOptions(command: string): { wslShellCommand?: string } {
  const ripgrepRoot = command.replace(/[\\/][^\\/]+[\\/][^\\/]+$/, '')
  if (command === PATH_RIPGREP_COMMAND || ripgrepRoot === command) {
    return {}
  }
  return {
    wslShellCommand: `"$(d=$(wslpath -u ${quotePosixShell(ripgrepRoot)} 2>/dev/null); case "$(uname -m)" in aarch64|arm64) a=linux-arm64;; *) a=linux-x64;; esac; if [ -n "$d" ]; then printf %s "$d/$a/rg"; else printf /dev/null/orca-ripgrep-unavailable; fi)"`
  }
}

/**
 * Short content hash of this install's binary for `platform`. Keys the SSH remote cache so any
 * change to the shipped bytes (a package bump, a rebuild, re-signing) re-uploads without a manual step.
 */
export function bundledRipgrepContentKey(platform: BundledRipgrepPlatform): string | null {
  if (!contentKeys.has(platform)) {
    contentKeys.set(platform, hashBinary(resolveBundledRipgrepPath(platform)))
  }
  return contentKeys.get(platform) ?? null
}

export function resetBundledRipgrepPathCacheForTests(): void {
  resolvedPaths.clear()
  contentKeys.clear()
}

// Why no git/readdir fallback: VS Code ships the same contract — a bundled rg that cannot start
// means a damaged install or security-software block, which a slower partial listing would hide.
export function bundledRipgrepUnavailableError(): Error {
  return new Error(
    "Orca's bundled search tool (ripgrep) could not start. Reinstall Orca, or allow it in your security software."
  )
}
