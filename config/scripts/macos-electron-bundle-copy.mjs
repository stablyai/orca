import { execFileSync } from 'node:child_process'
import { cpSync, rmSync } from 'node:fs'

const MACOS_CP = '/bin/cp'
export const MACOS_ELECTRON_CLONE_ARGS = Object.freeze(['-c', '-R', '-P'])

export function copyMacElectronBundle(sourcePath, destinationPath, options = {}) {
  const platform = options.platform ?? process.platform
  const copy = options.copy ?? copyElectronBundleNormally

  if (platform !== 'darwin') {
    copy(sourcePath, destinationPath)
    return { usedCloneCommand: false, cloneError: null }
  }

  const clone = options.clone ?? cloneElectronBundleWithCp
  const removePartial = options.removePartial ?? removePartialBundle
  try {
    clone(sourcePath, destinationPath)
    return { usedCloneCommand: true, cloneError: null }
  } catch (cloneError) {
    // cp can leave a partial bundle when cloning fails; clear only this fresh destination.
    try {
      removePartial(destinationPath)
    } catch (cleanupError) {
      throw new AggregateError(
        [cloneError, cleanupError],
        `Could not clean the partial Electron bundle clone at ${destinationPath}`
      )
    }
    console.warn('[orca-dev] APFS clone unavailable; using regular Electron copy')
    copy(sourcePath, destinationPath)
    return { usedCloneCommand: false, cloneError }
  }
}

export function cloneElectronBundleWithCp(sourcePath, destinationPath, options = {}) {
  const execFile = options.execFile ?? execFileSync
  execFile(MACOS_CP, [...MACOS_ELECTRON_CLONE_ARGS, sourcePath, destinationPath], {
    stdio: 'ignore'
  })
}

function copyElectronBundleNormally(sourcePath, destinationPath) {
  cpSync(sourcePath, destinationPath, { recursive: true, verbatimSymlinks: true })
}

function removePartialBundle(destinationPath) {
  rmSync(destinationPath, { recursive: true, force: true })
}
