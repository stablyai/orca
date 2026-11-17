import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const LOCAL_APP_DATA_MAX_LENGTH = 32_768

export type DefaultHermesHomeInput = {
  homeDir?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  directoryExists?: (candidate: string) => boolean
}

function usableLocalAppData(value: string | undefined): string | null {
  const candidate = value?.trim()
  if (
    !candidate ||
    candidate.length > LOCAL_APP_DATA_MAX_LENGTH ||
    candidate.includes('\0') ||
    !isAbsolute(candidate)
  ) {
    return null
  }
  return resolve(candidate)
}

function isExistingDirectory(candidate: string): boolean {
  return statSync(candidate, { throwIfNoEntry: false })?.isDirectory() === true
}

/**
 * The Hermes home when `HERMES_HOME` is unset. Windows installs land in
 * `%LOCALAPPDATA%\hermes`, not a dotfolder in the user profile. The dotfolder
 * still wins on Windows when it exists and the LOCALAPPDATA tree does not,
 * which is the pre-LOCALAPPDATA install Hermes Desktop keeps honouring.
 */
export function resolveDefaultHermesHome(input: DefaultHermesHomeInput = {}): string {
  const dotfolderHome = join(input.homeDir ?? homedir(), '.hermes')
  if ((input.platform ?? process.platform) !== 'win32') {
    return dotfolderHome
  }
  const localAppData = usableLocalAppData((input.env ?? process.env).LOCALAPPDATA)
  if (!localAppData) {
    return dotfolderHome
  }
  const localAppDataHome = join(localAppData, 'hermes')
  const directoryExists = input.directoryExists ?? isExistingDirectory
  return !directoryExists(localAppDataHome) && directoryExists(dotfolderHome)
    ? dotfolderHome
    : localAppDataHome
}

export function getHermesHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.HERMES_HOME?.trim()
  return explicit ? explicit : resolveDefaultHermesHome({ env })
}
