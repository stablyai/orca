import { statSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

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

export function getHermesHome(env: NodeJS.ProcessEnv = process.env, homeDir?: string): string {
  const explicit = env.HERMES_HOME?.trim()
  return explicit ? explicit : resolveDefaultHermesHome({ env, homeDir })
}

/**
 * The profile folder Hermes runs from `home`. Hermes trusts a `HERMES_HOME` inside `profiles/`;
 * for its root it follows the sticky `active_profile`, which `hermes profile use` changes.
 */
export async function resolveHermesActiveProfileHome(home: string): Promise<string> {
  if (basename(dirname(home)) === 'profiles') {
    return home
  }
  const name = await readFile(join(home, 'active_profile'), 'utf-8').then(
    (text) => text.replace(/^\uFEFF/u, '').trim(),
    () => ''
  )
  if (!name || name === 'default' || !/^[\w.-]+$/u.test(name)) {
    return home
  }
  const profile = join(home, 'profiles', name)
  const exists = await stat(profile).then(
    (entry) => entry.isDirectory(),
    () => false
  )
  return exists ? profile : home
}
