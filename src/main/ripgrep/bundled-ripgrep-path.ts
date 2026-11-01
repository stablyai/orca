import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
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

/** os-arch install path, including expected paths for unsupported architectures. */
function candidatePaths(platform: string): string[] {
  const binaryName = bundledRipgrepBinaryName(platform)
  const candidates: string[] = []
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, BUNDLED_RIPGREP_RESOURCE_DIR, platform, binaryName))
  }
  // Packaged apps must never execute checkout-provided binaries.
  if (isPackagedApp()) {
    // Plain Node orcad lacks resourcesPath; its build places rg under the install root.
    candidates.push(
      join(getAppEnvironment().getAppPath(), BUNDLED_RIPGREP_RESOURCE_DIR, platform, binaryName)
    )
    return candidates
  }
  // Dev/test binaries live under node_modules in the checkout.
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

// Hash failure must not break relay deployment; this key only gates upload.
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
    // Resolve pnpm symlinks because SSH uploads reject linked paths.
    resolvedPaths.set(platform, found ? realpathOrSelf(found) : null)
  }
  return resolvedPaths.get(platform) ?? null
}

/** Use bundled host rg, or Linux rg for WSL; PATH fallback is dev/test only. */
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
  // Even unsupported/missing packaged builds must use an expected absolute path: bare rg lets Windows execute checkout-local rg.exe.
  return candidatePaths(platform ?? `${os}-${process.arch}`)[0] ?? PATH_RIPGREP_COMMAND
}

/** Guest uname selects Linux rg architecture, which can differ from Windows Orca; wslpath honors custom automount roots.
 * Inaccessible installs follow missing-tool handling. */
export function bundledRipgrepWslSpawnOptions(command: string): { wslShellCommand?: string } {
  const ripgrepRoot = command.replace(/[\\/][^\\/]+[\\/][^\\/]+$/, '')
  if (command === PATH_RIPGREP_COMMAND || ripgrepRoot === command) {
    return {}
  }
  return {
    wslShellCommand: `"$(d=$(wslpath -u ${quotePosixShell(ripgrepRoot)} 2>/dev/null); case "$(uname -m)" in aarch64|arm64) a=linux-arm64;; *) a=linux-x64;; esac; if [ -n "$d" ]; then printf %s "$d/$a/rg"; else printf /dev/null/orca-ripgrep-unavailable; fi)"`
  }
}

/** Hash shipped bytes so package changes, rebuilds and signing changes invalidate SSH upload caches. */
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

// No git/readdir fallback: partial listings would hide damaged installs or security-software blocks.
export function bundledRipgrepUnavailableError(): Error {
  return new Error(
    "Orca's bundled search tool (ripgrep) could not start. Reinstall Orca, or allow it in your security software."
  )
}
