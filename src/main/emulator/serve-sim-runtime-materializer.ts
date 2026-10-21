import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import { dirname, join } from 'node:path'

export type ServeSimRuntimeMaterializerOptions = {
  bundledPackageDir: string
  targetRootDir: string
  version: string
  clearQuarantine?: (dir: string) => void
}

function defaultClearQuarantine(dir: string): void {
  if (process.platform !== 'darwin') {
    return
  }
  // Why: a downloaded/updated .app carries com.apple.quarantine, and cpSync
  // clones it onto the copy. serve-sim DYLD-injects libSimCameraInjector.dylib
  // (an iOS-simulator binary Apple never Gatekeeper-tickets) into a simulator
  // process; if that copy is quarantined, syspolicyd malware-rejects the load.
  // Running from an unquarantined copy is what avoids the rejection (#6877).
  // Remove only the quarantine attribute (not `-cr`, which strips every xattr);
  // recursive `-d` exits 0 even for files that never had it.
  execFileSync('/usr/bin/xattr', ['-rd', 'com.apple.quarantine', dir], { timeout: 30_000 })
}

function pruneStaleServeSimRuntimes(targetRootDir: string, keepVersion: string): void {
  let entries: string[]
  try {
    entries = readdirSync(targetRootDir)
  } catch {
    return
  }
  for (const entryName of entries) {
    if (entryName === keepVersion) {
      continue
    }
    try {
      rmSync(join(targetRootDir, entryName), { recursive: true, force: true })
    } catch {
      // Old-version cleanup is best-effort; a locked file must not block materialization.
    }
  }
}

function readDependencyNames(packageDir: string): string[] {
  const manifest: unknown = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  if (!manifest || typeof manifest !== 'object' || !('dependencies' in manifest)) {
    return []
  }
  const { dependencies } = manifest
  return dependencies && typeof dependencies === 'object' ? Object.keys(dependencies) : []
}

// Why: the copy has no node_modules of its own, so its bare imports (e.g. `ws`) must resolve
// through links to the bundle's installed siblings; a dangling link (moved or translocated app) is stale.
function bundledDependencyLinks(
  bundledPackageDir: string,
  runtimeNodeModulesDir: string
): { linkPath: string; targetPath: string }[] {
  const bundledNodeModulesDir = dirname(realpathSync(bundledPackageDir))
  return readDependencyNames(bundledPackageDir)
    .map((name) => ({
      linkPath: join(runtimeNodeModulesDir, name),
      targetPath: join(bundledNodeModulesDir, name)
    }))
    .filter(({ targetPath }) => existsSync(targetPath))
}

function isMaterializedRuntimeCurrent(bundledPackageDir: string, versionDir: string): boolean {
  const nodeModulesDir = join(versionDir, 'node_modules')
  if (!existsSync(join(nodeModulesDir, 'serve-sim', 'dist', 'serve-sim.js'))) {
    return false
  }
  try {
    return bundledDependencyLinks(bundledPackageDir, nodeModulesDir).every(
      ({ linkPath, targetPath }) => realpathSync(linkPath) === realpathSync(targetPath)
    )
  } catch {
    return false
  }
}

// Copies the bundled serve-sim package to a per-version directory outside the
// signed app bundle and strips quarantine, so the camera dylib injected from
// it is not subject to Gatekeeper assessment. The bundled dylib stays signed
// and in place (it must, or the app fails notarization) — this only relocates
// the copy that actually gets DYLD-injected. serve-sim resolves the dylib and
// helper relative to its own entry, so the whole package moves together.
// Layout: <version>/node_modules/serve-sim plus links to its bundled dependencies.
export function materializeServeSimRuntime(
  options: ServeSimRuntimeMaterializerOptions
): string | null {
  const { bundledPackageDir, targetRootDir, version } = options
  const clearQuarantine = options.clearQuarantine ?? defaultClearQuarantine
  const targetDir = join(targetRootDir, version)
  const packageDir = join(targetDir, 'node_modules', 'serve-sim')
  if (isMaterializedRuntimeCurrent(bundledPackageDir, targetDir)) {
    return packageDir
  }
  const stagingDir = join(targetRootDir, `.staging-${version}-${process.pid}`)
  const stagingNodeModulesDir = join(stagingDir, 'node_modules')
  try {
    mkdirSync(targetRootDir, { recursive: true })
    pruneStaleServeSimRuntimes(targetRootDir, version)
    rmSync(stagingDir, { recursive: true, force: true })
    rmSync(targetDir, { recursive: true, force: true })
    const stagingPackageDir = join(stagingNodeModulesDir, 'serve-sim')
    // Why realpath: cpSync copies a symlinked package dir (pnpm layout) as a link back into the bundle.
    cpSync(realpathSync(bundledPackageDir), stagingPackageDir, { recursive: true })
    // Why before linking: the recursive xattr walk must not reach into the signed bundle.
    clearQuarantine(stagingPackageDir)
    for (const { linkPath, targetPath } of bundledDependencyLinks(
      bundledPackageDir,
      stagingNodeModulesDir
    )) {
      mkdirSync(dirname(linkPath), { recursive: true })
      symlinkSync(targetPath, linkPath, 'junction')
    }
    try {
      renameSync(stagingDir, targetDir)
    } catch (error) {
      // Another app instance sharing userData may have finished first.
      if (!isMaterializedRuntimeCurrent(bundledPackageDir, targetDir)) {
        throw error
      }
    }
    return isMaterializedRuntimeCurrent(bundledPackageDir, targetDir) ? packageDir : null
  } catch {
    return null
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
  }
}
