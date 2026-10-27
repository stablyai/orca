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
  // Clear only quarantine: copied simulator dylibs have no Gatekeeper ticket, but other xattrs must survive.
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

// Link bare imports to bundled dependencies; moved bundles make existing links stale.
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

// Relocate the whole package for relative helper/dylib paths while preserving the signed bundle.
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
