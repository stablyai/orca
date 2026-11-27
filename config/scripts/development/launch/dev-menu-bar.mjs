import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import {
  buildMenuBarApp,
  menuBarAppFiles,
  menuBarBuildIdentity
} from '../../native-build/macos/build-menu-bar-macos.mjs'
import { DEV_BUNDLE_ID } from '../electron-bundle-cache/dev-electron-bundle-identity.mjs'

const repoRoot = path.resolve(import.meta.dirname, '../../../..')
function sign(appPath) {
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit'
  })
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: 'inherit'
  })
}

/** Stock Electron stays untouched; publish an immutable signed helper before launching it. */
export function prepareStandaloneDevMenuBar(
  enabled = true,
  {
    root = repoRoot,
    env = process.env,
    platform = process.platform,
    build = buildMenuBarApp,
    signApp = sign
  } = {}
) {
  delete env.ORCA_DEV_MENU_BAR_EXECUTABLE
  if (!enabled || platform !== 'darwin' || env.ORCA_SKIP_DEV_ELECTRON_APP_PREPARE === '1') {
    return
  }
  const cacheRoot = path.join(root, 'native/menu-bar-macos/.build/dev')
  const cacheDir = path.join(cacheRoot, `${menuBarBuildIdentity(root)}-${process.arch}`)
  const appPath = path.join(cacheDir, 'Orca Menu Bar.app')
  const files = menuBarAppFiles(appPath)
  if (!files.every(existsSync)) {
    mkdirSync(cacheRoot, { recursive: true })
    const staging = mkdtempSync(path.join(cacheRoot, 'staging-'))
    try {
      const stagedApp = path.join(staging, 'Orca Menu Bar.app')
      build({ appPath: stagedApp, bundleId: `${DEV_BUNDLE_ID}.menu-bar`, singleArch: true })
      signApp(stagedApp)
      renameSync(staging, cacheDir)
    } catch (error) {
      // Another launch may have published the same immutable artifact concurrently.
      if (!files.every(existsSync)) {
        throw error
      }
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }
  env.ORCA_DEV_MENU_BAR_EXECUTABLE = files[0]
}
