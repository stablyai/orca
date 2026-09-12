import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import {
  WSL_HOOK_RELAY_BUNDLE_NAME,
  WSL_HOOK_RELAY_BUN_REQUIRED_FILE,
  WSL_HOOK_RELAY_VERSION_FILE
} from '../../shared/wsl-hook-relay-contract'

export type WslHookRelayBundle = {
  jsPath: string
  version: string
  /** Optional staged Bun executables keyed by `<arch>-<libc>`. */
  bunRuntimePaths?: Record<string, string>
  /** Release bundles set this so a missing Bun never falls back to distro Node. */
  requiresBundledBun?: boolean
}

export function resolveWslHookRelayBundle(): WslHookRelayBundle | null {
  // Mirrors getLocalRelayCandidates in ssh-relay-deploy: env override for
  // tests/dev, then packaged extraResources, then dev out/ paths.
  const candidates: string[] = []
  if (process.env.ORCA_RELAY_PATH) {
    candidates.push(join(process.env.ORCA_RELAY_PATH, 'wsl'))
  }
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'relay', 'wsl'))
    candidates.push(join(process.resourcesPath, 'app.asar.unpacked', 'out', 'relay', 'wsl'))
  }
  try {
    const appPath = getAppEnvironment().getAppPath()
    candidates.push(join(appPath, 'resources', 'relay', 'wsl'))
    candidates.push(join(appPath, 'out', 'relay', 'wsl'))
  } catch {
    // app not ready in some test contexts — env/resources candidates suffice.
  }
  for (const dir of candidates) {
    const jsPath = join(dir, WSL_HOOK_RELAY_BUNDLE_NAME)
    const versionPath = join(dir, WSL_HOOK_RELAY_VERSION_FILE)
    if (existsSync(jsPath) && existsSync(versionPath)) {
      const version = readFileSync(versionPath, 'utf8').trim()
      // Why: the version lands inside single-quoted guest shell text and in
      // a guest path segment — refuse anything outside the safe alphabet.
      if (/^[A-Za-z0-9+.-]+$/.test(version)) {
        const bunRuntimePaths: Record<string, string> = {}
        for (const key of ['x64-glibc', 'x64-musl', 'arm64-glibc', 'arm64-musl']) {
          const runtimePath = join(dir, `bun-runtime-linux-${key}`)
          if (existsSync(runtimePath)) {
            bunRuntimePaths[key] = runtimePath
          }
        }
        return {
          jsPath,
          version,
          ...(existsSync(join(dir, WSL_HOOK_RELAY_BUN_REQUIRED_FILE))
            ? { requiresBundledBun: true }
            : {}),
          ...(Object.keys(bunRuntimePaths).length > 0 ? { bunRuntimePaths } : {})
        }
      }
    }
  }
  return null
}
