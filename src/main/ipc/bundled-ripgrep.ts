import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { parseWslPath } from '../wsl'

const requireFromMain = createRequire(__filename)

/** PATH lookup — the pre-bundling behavior, still correct for WSL and remote hosts. */
const PATH_RG = 'rg'

/** Redirect an in-archive path to its `asarUnpack` copy, which is the one that can be exec'd. */
function toUnpackedAsarPath(candidate: string): string {
  return candidate
    .replace(/app\.asar([/\\])/, 'app.asar.unpacked$1')
    .replace(/node_modules\.asar([/\\])/, 'node_modules.asar.unpacked$1')
}

/** Where the bundled binary may live, packaged layout first; empty when no prebuilt ships. */
function bundledRgCandidates(): string[] {
  const platformPackage = `ripgrep-${process.platform}-${process.arch}`
  const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const candidates: string[] = []

  // Why: prefer the known packaged layout over module resolution, which would have to
  // resolve a path inside app.asar for a file that packaging moved out of it.
  if (process.resourcesPath) {
    candidates.push(
      join(
        process.resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        '@vscode',
        platformPackage,
        'bin',
        binaryName
      )
    )
  }

  try {
    // Why: resolve the platform subpackage directly rather than importing @vscode/ripgrep —
    // its entry is ESM-only and the main bundle is CommonJS.
    candidates.push(
      toUnpackedAsarPath(requireFromMain.resolve(`@vscode/${platformPackage}/bin/${binaryName}`))
    )
  } catch {
    // No prebuilt subpackage is installed for this platform/arch.
  }

  return candidates
}

/**
 * Absolute path to the bundled ripgrep for this host, or null when no prebuilt ships
 * for the running platform/arch.
 *
 * Why the existsSync: handing spawn a path that is not on disk would fail the availability
 * probe and silently drop Quick Open back to the git fallback — the bug this bundling fixes.
 */
export function getBundledRgPath(): string | null {
  return bundledRgCandidates().find((candidate) => existsSync(candidate)) ?? null
}

/**
 * Resolve the `rg` command for a `wslAwareSpawn`, preferring the bundled binary.
 *
 * Why: a spawn bound for a WSL distro executes inside it, where a host-side binary path is
 * meaningless, so those keep PATH lookup. The check is deliberately not gated on
 * `process.platform === 'win32'` — a registered distro means WSL intent regardless of the
 * host, and falling back to PATH is the pre-existing behavior either way. Relay/SSH searches
 * run on the remote host and never reach this resolver.
 */
export function resolveRgCommand(options: { cwd?: string; wslDistro?: string } = {}): string {
  const routesThroughWsl = Boolean(
    (options.cwd ? parseWslPath(options.cwd) : null) ?? options.wslDistro
  )
  if (routesThroughWsl) {
    return PATH_RG
  }
  return getBundledRgPath() ?? PATH_RG
}
