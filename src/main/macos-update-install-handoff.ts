import { randomUUID } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isValidAppVersion } from '../shared/app-version'
import { writeDurableSecureJsonFile } from '../shared/secure-file'

export const MAC_UPDATE_INSTALL_HANDOFF_SCHEMA_VERSION = 1
export const MAC_UPDATE_INSTALL_HANDOFF_MAX_AGE_MS = 30 * 60_000
export const MAC_UPDATE_INSTALL_SHIPIT_APPEARANCE_MS = 30_000

const HANDOFF_DIRECTORY = 'com.stablyai.orca'
const HANDOFF_FILENAME = 'update-install-handoff-v1.json'
const HANDOFF_MAX_BYTES = 32 * 1024
const PROCESS_LIST_TIMEOUT_MS = 2_000
const PROCESS_LIST_MAX_BYTES = 16 * 1024 * 1024

export type MacUpdateInstallHandoff = {
  schemaVersion: 1
  attemptId: string
  sourceVersion: string
  targetVersion: string
  targetBundlePath: string
  createdAtMs: number
}

export type MacUpdateInstallHandoffHandle = Pick<MacUpdateInstallHandoff, 'attemptId'> & {
  filePath: string
}

type HandoffReadResult =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'valid'; handoff: MacUpdateInstallHandoff }

export function getMacUpdateInstallHandoffPath(appDataPath: string): string {
  return join(appDataPath, HANDOFF_DIRECTORY, HANDOFF_FILENAME)
}

export function resolveMacAppBundlePath(executablePath: string): string {
  const bundlePath = resolve(executablePath, '..', '..', '..')
  if (!bundlePath.toLowerCase().endsWith('.app')) {
    throw new Error('The updater executable is not inside a macOS app bundle')
  }
  return bundlePath
}

export function armMacUpdateInstallHandoff(options: {
  appDataPath: string
  executablePath: string
  isPackaged: boolean
  platform?: NodeJS.Platform
  sourceVersion: string
  targetVersion: string
  now?: number
}): MacUpdateInstallHandoffHandle | null {
  if ((options.platform ?? process.platform) !== 'darwin' || !options.isPackaged) {
    return null
  }
  if (!isValidAppVersion(options.sourceVersion) || !isValidAppVersion(options.targetVersion)) {
    throw new Error('The macOS update handoff requires valid source and target versions')
  }
  const filePath = getMacUpdateInstallHandoffPath(options.appDataPath)
  const handoff: MacUpdateInstallHandoff = {
    schemaVersion: MAC_UPDATE_INSTALL_HANDOFF_SCHEMA_VERSION,
    attemptId: randomUUID(),
    sourceVersion: options.sourceVersion,
    targetVersion: options.targetVersion,
    targetBundlePath: resolveMacAppBundlePath(options.executablePath),
    createdAtMs: options.now ?? Date.now()
  }
  writeDurableSecureJsonFile(filePath, handoff)
  return { attemptId: handoff.attemptId, filePath }
}

export function clearMacUpdateInstallHandoff(handle: MacUpdateInstallHandoffHandle | null): void {
  if (!handle) {
    return
  }
  const current = readHandoff(handle.filePath)
  if (current.kind === 'valid' && current.handoff.attemptId !== handle.attemptId) {
    return
  }
  removeHandoff(handle.filePath)
}

export function parseSameExecutablePids(
  processList: string,
  executablePath: string,
  currentPid: number
): number[] {
  const pids: number[] = []
  for (const line of processList.split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) {
      continue
    }
    const pid = Number(match[1])
    if (pid !== currentPid && match[2] === executablePath) {
      pids.push(pid)
    }
  }
  return pids
}

export async function findConflictingMacAppPids(
  options: {
    platform?: NodeJS.Platform
    executablePath?: string
    currentPid?: number
    readProcessList?: () => Promise<string>
  } = {}
): Promise<number[] | null> {
  if ((options.platform ?? process.platform) !== 'darwin') {
    return []
  }
  try {
    const processList = await (options.readProcessList ?? readCurrentUserProcessList)()
    return parseSameExecutablePids(
      processList,
      options.executablePath ?? process.execPath,
      options.currentPid ?? process.pid
    )
  } catch {
    return null
  }
}

export function isMatchingBundleShipItRunning(
  targetBundlePath: string,
  processCommandList: string
): boolean {
  const shipItPath = join(
    targetBundlePath,
    'Contents',
    'Frameworks',
    'Squirrel.framework',
    'Resources',
    'ShipIt'
  )
  return processCommandList.split('\n').some((line) => {
    const command = line.trimStart()
    return command === shipItPath || command.startsWith(`${shipItPath} `)
  })
}

export function shouldDeferMacLaunchForUpdate(options: {
  appDataPath: string
  appVersion: string
  executablePath: string
  isPackaged: boolean
  platform?: NodeJS.Platform
  now?: number
  readProcessList?: () => string
}): boolean {
  if ((options.platform ?? process.platform) !== 'darwin' || !options.isPackaged) {
    return false
  }
  const filePath = getMacUpdateInstallHandoffPath(options.appDataPath)
  const current = readHandoff(filePath)
  if (current.kind !== 'valid') {
    return false
  }
  const handoff = current.handoff
  const currentBundlePath = resolveMacAppBundlePath(options.executablePath)
  if (!macPathsEqual(handoff.targetBundlePath, currentBundlePath)) {
    return false
  }
  if (options.appVersion === handoff.targetVersion) {
    removeHandoff(filePath)
    return false
  }
  // Exact equality is required: an RC source can intentionally install a semver-lower ad hoc target.
  const ageMs = (options.now ?? Date.now()) - handoff.createdAtMs
  if (ageMs < 0 || ageMs > MAC_UPDATE_INSTALL_HANDOFF_MAX_AGE_MS) {
    removeHandoff(filePath)
    return false
  }
  if (ageMs <= MAC_UPDATE_INSTALL_SHIPIT_APPEARANCE_MS) {
    return true
  }

  try {
    const processList = (options.readProcessList ?? readAllProcessCommands)()
    if (isMatchingBundleShipItRunning(handoff.targetBundlePath, processList)) {
      return true
    }
  } catch {
    return true
  }
  removeHandoff(filePath)
  return false
}

function readHandoff(filePath: string): HandoffReadResult {
  try {
    if (!existsSync(filePath)) {
      return { kind: 'missing' }
    }
    const stats = lstatSync(filePath)
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > HANDOFF_MAX_BYTES) {
      return { kind: 'invalid' }
    }
    const value = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<MacUpdateInstallHandoff>
    if (
      value.schemaVersion !== MAC_UPDATE_INSTALL_HANDOFF_SCHEMA_VERSION ||
      typeof value.attemptId !== 'string' ||
      !isValidAppVersion(value.sourceVersion ?? '') ||
      !isValidAppVersion(value.targetVersion ?? '') ||
      typeof value.targetBundlePath !== 'string' ||
      !value.targetBundlePath.startsWith('/') ||
      !value.targetBundlePath.toLowerCase().endsWith('.app') ||
      !Number.isSafeInteger(value.createdAtMs) ||
      (value.createdAtMs ?? 0) <= 0
    ) {
      return { kind: 'invalid' }
    }
    return { kind: 'valid', handoff: value as MacUpdateInstallHandoff }
  } catch {
    return { kind: 'invalid' }
  }
}

function removeHandoff(filePath: string): void {
  try {
    rmSync(filePath, { force: true })
  } catch {
    // A stale handoff self-expires; cleanup must never prevent startup.
  }
}

function readCurrentUserProcessList(): Promise<string> {
  return new Promise((resolveProcessList, reject) => {
    execFile(
      '/bin/ps',
      ['-xww', '-o', 'pid=,comm='],
      { encoding: 'utf8', timeout: PROCESS_LIST_TIMEOUT_MS, maxBuffer: PROCESS_LIST_MAX_BYTES },
      (error, stdout) => {
        if (error) {
          reject(error)
        } else {
          resolveProcessList(stdout)
        }
      }
    )
  })
}

function readAllProcessCommands(): string {
  return execFileSync('/bin/ps', ['-ww', '-axo', 'command='], {
    encoding: 'utf8',
    timeout: PROCESS_LIST_TIMEOUT_MS,
    maxBuffer: PROCESS_LIST_MAX_BYTES
  })
}

function macPathsEqual(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    resolve(value)
      .replace(/^\/System\/Volumes\/Data(?=\/)/i, '')
      .normalize('NFC')
      .toLocaleLowerCase('en-US')
  return normalize(left) === normalize(right)
}
