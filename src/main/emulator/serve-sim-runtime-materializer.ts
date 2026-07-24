import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export type ServeSimRuntimeMaterializerOptions = {
  bundledPackageDir: string
  targetRootDir: string
  version: string
  clearQuarantine?: (dir: string) => void
}

const EXECUTABLE_RELATIVE_PATHS = [
  join('bin', 'serve-sim-bin'),
  join('dist', 'simcam', 'serve-sim-camera-helper')
]

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

// Copies the bundled serve-sim package to a per-version directory outside the
// signed app bundle and strips quarantine, so the camera dylib injected from
// it is not subject to Gatekeeper assessment. The bundled dylib stays signed
// and in place (it must, or the app fails notarization) — this only relocates
// the copy that actually gets DYLD-injected. serve-sim resolves the dylib and
// helper relative to its own entry, so the whole package moves together.
export function materializeServeSimRuntime(
  options: ServeSimRuntimeMaterializerOptions
): string | null {
  const { bundledPackageDir, targetRootDir, version } = options
  const clearQuarantine = options.clearQuarantine ?? defaultClearQuarantine
  const targetDir = join(targetRootDir, version)
  const entryPath = join(targetDir, 'dist', 'serve-sim.js')
  if (existsSync(entryPath)) {
    return targetDir
  }
  const stagingDir = join(targetRootDir, `.staging-${version}-${process.pid}`)
  try {
    mkdirSync(targetRootDir, { recursive: true })
    pruneStaleServeSimRuntimes(targetRootDir, version)
    rmSync(stagingDir, { recursive: true, force: true })
    rmSync(targetDir, { recursive: true, force: true })
    cpSync(bundledPackageDir, stagingDir, { recursive: true })
    for (const relativePath of EXECUTABLE_RELATIVE_PATHS) {
      const executablePath = join(stagingDir, relativePath)
      if (existsSync(executablePath)) {
        chmodSync(executablePath, 0o755)
      }
    }
    clearQuarantine(stagingDir)
    try {
      renameSync(stagingDir, targetDir)
    } catch (error) {
      // Another app instance sharing userData may have finished first.
      if (!existsSync(entryPath)) {
        throw error
      }
    }
    return existsSync(entryPath) ? targetDir : null
  } catch {
    return null
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
  }
}
