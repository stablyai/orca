import { constants } from 'node:fs'
import { access, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

// The Muse Code changelog lists `muse usage` as new in 1.4.13; older builds treat it as a prompt.
const MUSE_MIN_USAGE_VERSION: readonly number[] = [1, 4, 13]
// Same shape the `muse` launcher accepts in `.muse-version`, e.g. `1.4.14-R7309.1`.
const MUSE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)-R\d+(?:\.\d+)?$/

export type MuseInstall =
  // The launcher's `.muse-version` names the active build; `program` is its binary when present.
  | {
      kind: 'versioned'
      program: string
      version: string
      versionFile: string
      supportsUsage: boolean
    }
  // Any other layout: only `muse --help` can tell whether `usage` exists.
  | { kind: 'unversioned'; program: string; launcherPath: string }

export async function readMuseVersionFile(versionFile: string): Promise<string | null> {
  try {
    const version = (await readFile(versionFile, 'utf8')).trim()
    return MUSE_VERSION_PATTERN.test(version) ? version : null
  } catch {
    return null
  }
}

function supportsUsageCommand(version: string): boolean {
  const parts = MUSE_VERSION_PATTERN.exec(version)?.slice(1, 4).map(Number) ?? []
  for (let index = 0; index < MUSE_MIN_USAGE_VERSION.length; index += 1) {
    const part = parts[index] ?? 0
    if (part !== MUSE_MIN_USAGE_VERSION[index]) {
      return part > MUSE_MIN_USAGE_VERSION[index]
    }
  }
  return true
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function resolveMuseInstall(command: string): Promise<MuseInstall> {
  // The launcher follows its own symlinks to find the install dir, so do the same.
  const launcherPath = await realpath(command).catch(() => command)
  const dir = path.dirname(launcherPath)
  const versionFile = path.join(dir, '.muse-version')
  const version = await readMuseVersionFile(versionFile)
  if (!version) {
    return { kind: 'unversioned', program: command, launcherPath }
  }
  const binary = path.join(dir, `muse-bin-${version}`)
  return {
    kind: 'versioned',
    // Running the build directly skips the launcher's update, sign-in and install paths.
    program: (await isExecutable(binary)) ? binary : command,
    version,
    versionFile,
    supportsUsage: supportsUsageCommand(version)
  }
}
