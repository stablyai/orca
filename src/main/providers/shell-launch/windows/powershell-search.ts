import { win32 as pathWin32 } from 'node:path'
import {
  discoverWindowsPwshInstalls,
  isRealWindowsExecutable,
  readWindowsEnv,
  readWindowsPathValue,
  selectWindowsPwsh,
  type WindowsPwshInstall
} from './pwsh-discovery'

export type WindowsPowerShellResolveOptions = {
  /** The environment the terminal will get. */
  env?: NodeJS.ProcessEnv
  /** The requested shell setting; a different value searches again. */
  settingKey?: string
  preferPreview?: boolean
  platform?: NodeJS.Platform
}

type PwshSearch = {
  /** Null for a warm-up search, which the first request's setting adopts. */
  settingKey: string | null
  searchedPath: string
  installs: Promise<WindowsPwshInstall[]>
  settled?: WindowsPwshInstall[]
  /** False when a probe missed its deadline: an empty result is then not a confirmed miss. */
  complete?: boolean
  missLogged?: boolean
}

// Cached per process (main and the terminal daemon each keep one) so tab opens never search the disk.
let pwshSearch: PwshSearch | null = null
let windowsPowerShellFound: string | null = null

function readPath(env: NodeJS.ProcessEnv): string {
  return readWindowsPathValue(env)
}

function startPwshSearch(
  settingKey: string | null,
  options: WindowsPowerShellResolveOptions
): PwshSearch {
  const env = options.env ?? process.env
  const search: PwshSearch = {
    settingKey,
    searchedPath: readPath(env),
    installs: discoverWindowsPwshInstalls(env).then(
      (discovery) => {
        search.settled = discovery.installs
        search.complete = discovery.complete
        return discovery.installs
      },
      (error: unknown) => {
        // A failed search must not pin the result; the next spawn searches again.
        if (pwshSearch === search) {
          pwshSearch = null
        }
        console.warn('[pty] PowerShell 7 (pwsh.exe) search failed:', error)
        return []
      }
    )
  }
  return search
}

/** Searches once per shell setting; a miss is searched again only when the terminal's PATH differs. */
export async function findWindowsPwsh(
  options: WindowsPowerShellResolveOptions
): Promise<string | null> {
  const settingKey = options.settingKey ?? ''
  const requestPath = readPath(options.env ?? process.env)
  if (pwshSearch?.settingKey === null) {
    pwshSearch.settingKey = settingKey
  }
  let search = pwshSearch
  if (!search || search.settingKey !== settingKey) {
    search = startPwshSearch(settingKey, options)
    pwshSearch = search
  }
  let installs = await search.installs
  // A daemon started before an install sees a stale PATH; the terminal's PATH may know better.
  if (installs.length === 0 && search.searchedPath !== requestPath) {
    if (pwshSearch === search || pwshSearch?.settingKey !== settingKey) {
      pwshSearch = startPwshSearch(settingKey, options)
    }
    search = pwshSearch
    installs = await search.installs
  }
  if (installs.length === 0 && search.complete === false) {
    // Only an unanswered probe kept this empty; the next terminal searches again.
    if (pwshSearch === search) {
      pwshSearch = null
    }
  } else if (installs.length === 0 && !search.missLogged) {
    search.missLogged = true
    console.warn(
      '[pty] PowerShell 7 (pwsh.exe) was not found in Program Files, the per-user install folder, PATH, App Paths, the Store install, or user tool folders'
    )
  }
  return selectWindowsPwsh(installs, options.preferPreview === true)
}

/** Starts the search before the first terminal asks, so that terminal opens no slower. */
export function warmWindowsPwshSearch(): void {
  if (process.platform === 'win32' && !pwshSearch) {
    pwshSearch = startPwshSearch(null, {})
  }
}

export async function findWindowsPowerShell(env: NodeJS.ProcessEnv): Promise<string | null> {
  const systemRoot = readWindowsEnv([env], ['SystemRoot', 'WINDIR', 'windir']) || 'C:\\Windows'
  const candidate = pathWin32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  if (windowsPowerShellFound === candidate) {
    return candidate
  }
  // Only a hit is cached: a missing inbox shell is rare and must not stick.
  if (!(await isRealWindowsExecutable(candidate))) {
    return null
  }
  windowsPowerShellFound = candidate
  return candidate
}

/** A launch of a cached shell failed: search again on the next spawn. */
export function forgetWindowsPowerShellAfterLaunchFailure(shellPath: string): void {
  const failed = pathWin32.normalize(shellPath).toLowerCase()
  if (pwshSearch?.settled?.some((install) => install.path.toLowerCase() === failed)) {
    pwshSearch = null
  }
  if (windowsPowerShellFound?.toLowerCase() === failed) {
    windowsPowerShellFound = null
  }
}
