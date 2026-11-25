import { access, readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, posix, win32 } from 'node:path'
import type { OrcaUninstallInstallKind } from '../../shared/uninstall/orca-uninstall-types'

export type OrcaInstallIdentity = {
  installKind: OrcaUninstallInstallKind
  appPath: string | null
  removeAppCommand: string | null
  /** Another Orca build that runs the same ~/.orca hook scripts. */
  otherOrcaBuildName: string | null
}

export type OrcaInstallIdentityInput = {
  platform: NodeJS.Platform
  isPackaged: boolean
  /** The running Orca executable (Electron's `exe` path). */
  exePath: string
  homeDir: string
  env: NodeJS.ProcessEnv
  linuxPackageType: 'deb' | 'rpm' | null
  exists?: (path: string) => Promise<boolean>
  readText?: (path: string) => Promise<string | null>
  listDir?: (path: string) => Promise<string[]>
}

// Every channel (stable, RC, dev builds) ships this bundle id; see config/electron-builder.config.cjs.
const ORCA_BUNDLE_ID = 'com.stablyai.orca'
// Cask tokens from Casks/orca.rb and Casks/orca@rc.rb.
const ORCA_CASKS = ['orca', 'orca@rc']
const CASKROOMS = ['/opt/homebrew/Caskroom', '/usr/local/Caskroom']
const LINUX_PACKAGE_NAME = 'orca-ide'
const LINUX_PACKAGE_EXECUTABLE = '/opt/Orca/orca-ide'

function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  )
}

function readTextOrNull(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null)
}

function listDirOrEmpty(path: string): Promise<string[]> {
  return readdir(path).catch(() => [])
}

function macBundleOf(exePath: string): string | null {
  const index = exePath.indexOf('.app/')
  return index === -1 ? null : exePath.slice(0, index + '.app'.length)
}

async function otherMacBuild(
  input: Required<OrcaInstallIdentityInput>,
  own: string | null
): Promise<string | null> {
  for (const dir of ['/Applications', join(input.homeDir, 'Applications')]) {
    for (const name of await input.listDir(dir)) {
      const bundle = posix.join(dir, name)
      if (!name.endsWith('.app') || bundle === own) {
        continue
      }
      const plist = await input.readText(posix.join(bundle, 'Contents', 'Info.plist'))
      if (plist?.includes(`<string>${ORCA_BUNDLE_ID}</string>`)) {
        return basename(name, '.app')
      }
    }
  }
  return null
}

function windowsInstallDirs(env: NodeJS.ProcessEnv): string[] {
  return [
    env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, 'Programs', 'Orca') : null,
    env.ProgramFiles ? win32.join(env.ProgramFiles, 'Orca') : null
  ].filter((dir): dir is string => dir !== null)
}

// Mirrors config/nsis/orca-other-install-check.nsh: the other registration is the other install dir.
async function otherWindowsBuild(
  input: Required<OrcaInstallIdentityInput>,
  own: string | null
): Promise<string | null> {
  for (const dir of windowsInstallDirs(input.env)) {
    if (
      dir.toLowerCase() !== own?.toLowerCase() &&
      (await input.exists(win32.join(dir, 'Orca.exe')))
    ) {
      return `Orca in ${dir}`
    }
  }
  return null
}

async function homebrewCask(input: Required<OrcaInstallIdentityInput>): Promise<string | null> {
  for (const cask of ORCA_CASKS) {
    for (const root of CASKROOMS) {
      if (await input.exists(posix.join(root, cask))) {
        return cask
      }
    }
  }
  return null
}

async function hasLinuxPackage(input: Required<OrcaInstallIdentityInput>): Promise<string | null> {
  return (await input.exists(LINUX_PACKAGE_EXECUTABLE)) ? 'Orca (system package)' : null
}

export async function resolveOrcaInstallIdentity(
  raw: OrcaInstallIdentityInput
): Promise<OrcaInstallIdentity> {
  const input: Required<OrcaInstallIdentityInput> = {
    exists: pathExists,
    readText: readTextOrNull,
    listDir: listDirOrEmpty,
    ...raw
  }
  const none = { removeAppCommand: null, otherOrcaBuildName: null }
  if (input.platform === 'darwin') {
    const appPath = input.isPackaged ? macBundleOf(input.exePath) : null
    const otherOrcaBuildName = await otherMacBuild(input, appPath)
    if (!appPath) {
      return { ...none, installKind: 'unknown', appPath: null, otherOrcaBuildName }
    }
    // A cask installs into /Applications; a copy elsewhere is the user's own.
    const cask = dirname(appPath) === '/Applications' ? await homebrewCask(input) : null
    return cask
      ? {
          installKind: 'mac-homebrew',
          appPath,
          removeAppCommand: `brew uninstall --cask ${cask}`,
          otherOrcaBuildName
        }
      : { ...none, installKind: 'mac-app', appPath, otherOrcaBuildName }
  }
  if (input.platform === 'win32') {
    const appPath = input.isPackaged ? win32.dirname(input.exePath) : null
    return {
      ...none,
      installKind: appPath ? 'windows-installer' : 'unknown',
      appPath,
      otherOrcaBuildName: await otherWindowsBuild(input, appPath)
    }
  }
  if (input.platform === 'linux') {
    const appImage = input.isPackaged ? input.env.APPIMAGE?.trim() || null : null
    if (appImage) {
      return {
        ...none,
        installKind: 'linux-appimage',
        appPath: appImage,
        otherOrcaBuildName: await hasLinuxPackage(input)
      }
    }
    if (input.isPackaged && input.linuxPackageType) {
      const manager = input.linuxPackageType === 'deb' ? 'apt' : 'dnf'
      return {
        installKind: 'linux-package',
        appPath: dirname(input.exePath),
        removeAppCommand: `sudo ${manager} remove ${LINUX_PACKAGE_NAME}`,
        otherOrcaBuildName: null
      }
    }
    return {
      ...none,
      installKind: 'unknown',
      appPath: null,
      otherOrcaBuildName: input.isPackaged ? null : await hasLinuxPackage(input)
    }
  }
  return { ...none, installKind: 'unknown', appPath: null }
}

/** NSIS writes `Uninstall <product>.exe` beside the app. */
export async function findWindowsUninstaller(
  installDir: string,
  listDir: (path: string) => Promise<string[]> = listDirOrEmpty
): Promise<string | null> {
  const file = (await listDir(installDir)).find((name) => /^Uninstall .+\.exe$/i.test(name))
  return file ? win32.join(installDir, file) : null
}
