import { readdir, readlink, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { win32 as pathWin32 } from 'node:path'
import { expandWindowsEnvironmentVariables } from '../../../../shared/windows-environment-expansion'
import {
  loadWindowsNativeRegistry,
  WINDOWS_REG_EXPAND_SZ,
  WINDOWS_REG_SZ
} from '../../../windows/windows-native-registry'

export type WindowsPwshInstall = { path: string; preview: boolean }

/** `complete` is false when a probe missed the deadline, so an empty result is not a confirmed miss. */
export type WindowsPwshDiscovery = { installs: WindowsPwshInstall[]; complete: boolean }

type Candidate = { path: string; alias: boolean }

const APP_PATHS_PWSH_KEY = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\pwsh.exe'
const VERSION_DIRECTORY = /^(\d+)(-preview)?$/i
const STORE_PACKAGE_DIRECTORY = /^Microsoft\.PowerShell(Preview)?_/i
// Local probes finish in milliseconds; this bounds only unreachable network PATH entries.
const PROBE_DEADLINE_MS = 1_000

/** Store alias reparse stubs may launch through execFile PATH lookup but fail ConPTY absolute CreateProcessW (5). */
export function isWindowsAppExecutionAliasPath(candidate: string): boolean {
  return /[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(pathWin32.normalize(candidate))
}

export function isPreviewPwshPath(candidate: string): boolean {
  return /[\\/]\d+-preview[\\/]|[\\/]Microsoft\.PowerShellPreview_/i.test(candidate)
}

export function readWindowsEnv(
  envs: readonly NodeJS.ProcessEnv[],
  names: readonly string[]
): string | undefined {
  for (const env of envs) {
    for (const name of names) {
      const value = env[name]
      if (value) {
        return value
      }
    }
  }
  return undefined
}

export async function isRealWindowsExecutable(candidate: string): Promise<boolean> {
  // Zero-byte alias stubs are never launchable even if a future Windows moves them.
  if (isWindowsAppExecutionAliasPath(candidate)) {
    return false
  }
  try {
    const info = await stat(candidate)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

async function resolveAppExecutionAlias(candidate: string): Promise<string | null> {
  try {
    const target = await readlink(candidate)
    return pathWin32.resolve(pathWin32.dirname(candidate), target)
  } catch {
    return null
  }
}

async function listDirectory(directory: string): Promise<string[]> {
  try {
    return await readdir(directory)
  } catch {
    return []
  }
}

function readAppPathValues(): string[] {
  let registry: ReturnType<typeof loadWindowsNativeRegistry>
  try {
    registry = loadWindowsNativeRegistry()
  } catch {
    return []
  }
  const values: string[] = []
  for (const root of [registry.HK.LM, registry.HK.CU]) {
    try {
      const entry = registry.getRegistryKey(root, APP_PATHS_PWSH_KEY)?.['']
      if (
        entry &&
        (entry.type === WINDOWS_REG_SZ || entry.type === WINDOWS_REG_EXPAND_SZ) &&
        typeof entry.value === 'string'
      ) {
        values.push(entry.value)
      }
    } catch {
      // An unreadable hive only removes this source.
    }
  }
  return values
}

function toCandidate(path: string): Candidate {
  return { path, alias: isWindowsAppExecutionAliasPath(path) }
}

/** `<root>\<version>\pwsh.exe` for every numbered install, highest major first. */
async function versionedInstallCandidates(roots: (string | undefined)[]): Promise<Candidate[]> {
  const uniqueRoots = [...new Set(roots.filter((root): root is string => Boolean(root)))]
  const listings = await Promise.all(uniqueRoots.map((root) => listDirectory(root)))
  const installs = listings.flatMap((names, rootIndex) =>
    names.flatMap((name) => {
      const match = VERSION_DIRECTORY.exec(name)
      return match
        ? [
            {
              major: Number(match[1]),
              path: pathWin32.join(uniqueRoots[rootIndex], name, 'pwsh.exe')
            }
          ]
        : []
    })
  )
  // Stable sort keeps 64-bit roots ahead of 32-bit ones for the same major.
  installs.sort((a, b) => b.major - a.major)
  return installs.map((install) => toCandidate(install.path))
}

/** Every PATH spelling in key order: a merged env object can hold both `PATH` and `Path`. */
export function readWindowsPathValue(env: NodeJS.ProcessEnv): string {
  return Object.keys(env)
    .filter((name) => name.toLowerCase() === 'path')
    .map((name) => env[name])
    .filter((value): value is string => Boolean(value))
    .join(pathWin32.delimiter)
}

function pathDirectoryCandidates(envs: readonly NodeJS.ProcessEnv[]): Candidate[] {
  const candidates: Candidate[] = []
  for (const env of envs) {
    for (const rawPart of readWindowsPathValue(env).split(pathWin32.delimiter)) {
      const dir = rawPart.trim().replace(/^"|"$/g, '')
      // Relative PATH entries enable repo-local shell hijacking; accept only absolute directories.
      if (pathWin32.isAbsolute(dir)) {
        candidates.push(toCandidate(pathWin32.join(dir, 'pwsh.exe')))
      }
    }
  }
  return candidates
}

function appPathCandidates(terminalEnv: NodeJS.ProcessEnv): Candidate[] {
  const expansionEnv = { ...process.env, ...terminalEnv }
  return readAppPathValues()
    .map((value) => expandWindowsEnvironmentVariables(value.trim(), expansionEnv))
    .map((value) => value.replace(/^"|"$/g, ''))
    .filter((value) => pathWin32.isAbsolute(value))
    .map(toCandidate)
}

async function storeCandidates(windowsApps: string | undefined): Promise<Candidate[]> {
  if (!windowsApps) {
    return []
  }
  const packageDirs = (await listDirectory(windowsApps)).filter((name) =>
    STORE_PACKAGE_DIRECTORY.test(name)
  )
  return [
    pathWin32.join(windowsApps, 'pwsh.exe'),
    ...packageDirs.flatMap((name) => [
      pathWin32.join(windowsApps, name, 'pwsh.exe'),
      pathWin32.join(windowsApps, name, 'pwsh-preview.exe')
    ])
  ].map(toCandidate)
}

async function probeCandidate(candidate: Candidate): Promise<string | null> {
  if (!candidate.alias) {
    return (await isRealWindowsExecutable(candidate.path)) ? candidate.path : null
  }
  const target = await resolveAppExecutionAlias(candidate.path)
  // ConPTY cannot launch the alias itself; its real package target preserves the requested pwsh.
  if (
    target &&
    pathWin32.isAbsolute(target) &&
    pathWin32.basename(target).toLowerCase() === 'pwsh.exe' &&
    !isWindowsAppExecutionAliasPath(target) &&
    (await isRealWindowsExecutable(target))
  ) {
    return pathWin32.normalize(target)
  }
  return null
}

/** Every launchable pwsh.exe, best first. Reads only; never starts pwsh. */
export async function discoverWindowsPwshInstalls(
  /** The environment the terminal will get; its PATH outranks this process's possibly stale one. */
  terminalEnv: NodeJS.ProcessEnv
): Promise<WindowsPwshDiscovery> {
  const envs = [terminalEnv, process.env]
  const programFilesRoots = [
    ['ProgramW6432', 'PROGRAMW6432'],
    ['ProgramFiles', 'PROGRAMFILES'],
    ['ProgramFiles(x86)', 'PROGRAMFILES(X86)']
  ].map((names) => {
    const root = readWindowsEnv(envs, names)
    return root ? pathWin32.join(root, 'PowerShell') : undefined
  })
  const localAppData = readWindowsEnv(envs, ['LOCALAPPDATA', 'LocalAppData'])
  const home = readWindowsEnv(envs, ['USERPROFILE', 'UserProfile']) ?? homedir()
  const [programFiles, perUser, store] = await Promise.all([
    versionedInstallCandidates(programFilesRoots),
    versionedInstallCandidates([
      localAppData ? pathWin32.join(localAppData, 'Microsoft', 'PowerShell') : undefined
    ]),
    storeCandidates(
      localAppData ? pathWin32.join(localAppData, 'Microsoft', 'WindowsApps') : undefined
    )
  ])
  const ordered = [
    ...programFiles,
    ...perUser,
    ...pathDirectoryCandidates(envs),
    ...appPathCandidates(terminalEnv),
    ...store,
    toCandidate(pathWin32.join(home, '.dotnet', 'tools', 'pwsh.exe')),
    toCandidate(pathWin32.join(home, 'scoop', 'apps', 'pwsh', 'current', 'pwsh.exe'))
  ]
  const seenCandidates = new Set<string>()
  const candidates = ordered.filter((candidate) => {
    const key = pathWin32.normalize(candidate.path).toLowerCase()
    if (seenCandidates.has(key)) {
      return false
    }
    seenCandidates.add(key)
    return true
  })
  // A PATH entry on an unresponsive share can stall stat; stop waiting rather than hold the tab.
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = Symbol('timed-out')
  const deadline = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), PROBE_DEADLINE_MS)
    timer.unref?.()
  })
  const resolved = await Promise.all(
    candidates.map((candidate) => Promise.race([probeCandidate(candidate), deadline]))
  ).finally(() => clearTimeout(timer))
  const installs: WindowsPwshInstall[] = []
  const seenInstalls = new Set<string>()
  resolved.forEach((path, index) => {
    if (path === timedOut) {
      return
    }
    const key = path?.toLowerCase()
    if (!path || !key || seenInstalls.has(key)) {
      return
    }
    seenInstalls.add(key)
    installs.push({
      path,
      preview: isPreviewPwshPath(path) || isPreviewPwshPath(candidates[index].path)
    })
  })
  return { installs, complete: !resolved.includes(timedOut) }
}

/** Stable unless only a preview exists; the reverse when the setting asks for a preview build. */
export function selectWindowsPwsh(
  installs: readonly WindowsPwshInstall[],
  preferPreview: boolean
): string | null {
  return (
    (installs.find((install) => install.preview === preferPreview) ?? installs[0])?.path ?? null
  )
}
