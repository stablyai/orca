/* eslint-disable max-lines -- Why: launch-home materialization needs path
safety, link/copy fallback, reconciliation, and cleanup in one place so
auth-only account isolation cannot drift across platforms. */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { getOrcaManagedCodexHomePath } from './codex-home-paths'

const LAUNCH_HOME_MARKER = '.orca-managed-launch-home'
const LAUNCH_HOME_LINK_MARKERS_DIR = '.orca-launch-home-links'
const LAUNCH_HOME_MARKER_VERSION = 1
const SHARED_LAUNCH_ENTRY_NAMES = new Set([
  'config.toml',
  'hooks.json',
  'history.jsonl',
  'sessions',
  'skills',
  'plugins',
  'plugin-state',
  'profile-v2',
  'themes',
  'prompts'
])
const MUTABLE_SHARED_FILE_ENTRIES = new Set([
  'config.toml',
  'hooks.json',
  'history.jsonl',
  'profile-v2'
])
const MUTABLE_SHARED_DIRECTORY_ENTRIES = new Set(['sessions', 'plugin-state', 'profile-v2'])

type LaunchEntryMarker = {
  version: number
  sourcePath: string
  mode: 'link' | 'copy'
  targetDigest: string | null
  sourceDigest: string | null
}

export function getOrcaCodexLaunchHomePath(accountId: string | null): string {
  return getScopedCodexLaunchHomePath(getOrcaCodexLaunchHostRootPath(), accountId)
}

export function ensureOrcaCodexLaunchHome(accountId: string | null): string {
  return ensureScopedCodexLaunchHome(getOrcaCodexLaunchHostRootPath(), accountId)
}

export function materializeOrcaCodexLaunchHome(accountId: string | null): string {
  return materializeScopedCodexLaunchHome(
    getOrcaManagedCodexHomePath(),
    getOrcaCodexLaunchHostRootPath(),
    accountId
  )
}

export function removeOrcaCodexLaunchHome(accountId: string): void {
  removeScopedCodexLaunchHome(
    getOrcaCodexLaunchHostRootPathWithOptions({ create: false }),
    accountId
  )
}

export function getScopedCodexLaunchHomePath(
  launchRootPath: string,
  accountId: string | null
): string {
  const launchHomePath = resolveCodexLaunchHomePath(launchRootPath, accountId)
  mkdirSync(launchHomePath, { recursive: true })
  return launchHomePath
}

export function ensureScopedCodexLaunchHome(
  launchRootPath: string,
  accountId: string | null
): string {
  const launchHomePath = getScopedCodexLaunchHomePath(launchRootPath, accountId)
  writeLaunchHomeMarker(launchHomePath, accountId)
  return launchHomePath
}

export function materializeScopedCodexLaunchHome(
  sharedHomePath: string,
  launchRootPath: string,
  accountId: string | null
): string {
  reconcileMutableLaunchHomeFilesIntoSharedHome(sharedHomePath, launchRootPath)
  const launchHomePath = getScopedCodexLaunchHomePath(launchRootPath, accountId)
  writeLaunchHomeMarker(launchHomePath, accountId)

  const sharedEntries = new Set<string>()
  for (const entryName of listSharedLaunchEntryNames(sharedHomePath)) {
    sharedEntries.add(entryName)
    linkSharedEntryIntoLaunchHome(sharedHomePath, launchHomePath, entryName)
  }
  removeStaleLaunchHomeEntries(launchHomePath, sharedHomePath, sharedEntries)
  return launchHomePath
}

export function removeScopedCodexLaunchHome(launchRootPath: string, accountId: string): void {
  const launchHomePath = resolveCodexLaunchHomePath(launchRootPath, accountId)
  if (!existsSync(launchHomePath)) {
    return
  }
  const launchHomeStat = lstatSync(launchHomePath)
  if (!launchHomeStat.isDirectory() || launchHomeStat.isSymbolicLink()) {
    console.warn('[codex-home] Refusing to remove unexpected launch-home root:', launchHomePath)
    return
  }
  if (!isMarkedLaunchHomeForAccount(launchHomePath, accountId)) {
    // Why: older builds could write auth before the launch-home marker existed.
    // Remove only the deterministic credential file, not an unmarked directory.
    rmSync(join(launchHomePath, 'auth.json'), { force: true })
    return
  }
  if (!isContainedPath(launchRootPath, launchHomePath)) {
    console.warn('[codex-home] Refusing to remove launch home outside host root:', launchHomePath)
    return
  }
  if (removeWslPathIfPossible(launchHomePath)) {
    return
  }
  rmSync(launchHomePath, { recursive: true, force: true })
}

function getOrcaCodexLaunchHostRootPath(): string {
  return getOrcaCodexLaunchHostRootPathWithOptions({ create: true })
}

function getOrcaCodexLaunchHostRootPathWithOptions(options: { create: boolean }): string {
  const rootPath = join(dirname(getOrcaManagedCodexHomePath()), 'launch', 'host')
  if (options.create) {
    mkdirSync(rootPath, { recursive: true })
  }
  return rootPath
}

function resolveCodexLaunchHomePath(launchRootPath: string, accountId: string | null): string {
  return join(launchRootPath, getLaunchSelectionSegment(accountId), 'home')
}

function getLaunchSelectionSegment(accountId: string | null): string {
  if (accountId === null) {
    return 'system'
  }
  return `account-${createHash('sha256').update(accountId).digest('hex').slice(0, 32)}`
}

function listSharedLaunchEntryNames(sharedHomePath: string): string[] {
  try {
    return readdirSync(sharedHomePath)
      .filter((entryName) => SHARED_LAUNCH_ENTRY_NAMES.has(entryName))
      .sort()
  } catch {
    return []
  }
}

function linkSharedEntryIntoLaunchHome(
  sharedHomePath: string,
  launchHomePath: string,
  entryName: string
): void {
  const sourcePath = join(sharedHomePath, entryName)
  const targetPath = join(launchHomePath, entryName)
  const existingMarker = readLaunchEntryMarker(launchHomePath, entryName)
  reconcileMutableLaunchEntryIfNeeded(sourcePath, targetPath, existingMarker)

  if (!existsSync(sourcePath)) {
    removeLaunchEntryIfOwned(targetPath, launchHomePath, entryName, sourcePath)
    return
  }
  if (targetAlreadyPointsToSource(targetPath, sourcePath)) {
    markLaunchEntry(launchHomePath, entryName, sourcePath, 'link')
    return
  }

  const ownedTarget =
    existingMarker?.sourcePath === sourcePath && targetExistsForLaunchRemoval(targetPath)
  if (targetExistsForLaunchRemoval(targetPath) && !ownedTarget) {
    return
  }
  if (ownedTarget) {
    removeLaunchEntry(targetPath)
  }

  try {
    createSharedEntryLink(sourcePath, targetPath)
    markLaunchEntry(launchHomePath, entryName, sourcePath, 'link')
  } catch (error) {
    if (!copyFallbackAllowed(sourcePath, entryName)) {
      console.warn('[codex-home] Failed to link shared Codex launch entry:', entryName, error)
      return
    }
    try {
      removeLaunchEntry(targetPath)
      cpSync(sourcePath, targetPath, {
        recursive: true,
        force: false,
        errorOnExist: true,
        dereference: true
      })
      markLaunchEntry(launchHomePath, entryName, sourcePath, 'copy')
    } catch {
      console.warn('[codex-home] Failed to copy shared Codex launch entry:', entryName, error)
    }
  }
}

function createSharedEntryLink(sourcePath: string, targetPath: string): void {
  if (createWslSymlinkIfPossible(sourcePath, targetPath)) {
    return
  }
  const sourceStat = lstatSync(sourcePath)
  symlinkSync(
    sourcePath,
    targetPath,
    sourceStat.isDirectory() && process.platform === 'win32' ? 'junction' : undefined
  )
}

function createWslSymlinkIfPossible(sourcePath: string, targetPath: string): boolean {
  const paths = getSameDistroWslPaths(sourcePath, targetPath)
  if (!paths) {
    return false
  }
  execFileSync(
    'wsl.exe',
    ['-d', paths.distro, '--', 'ln', '-s', paths.sourceLinuxPath, paths.targetLinuxPath],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000
    }
  )
  return true
}

function getSameDistroWslPaths(
  sourcePath: string,
  targetPath: string
): { distro: string; sourceLinuxPath: string; targetLinuxPath: string } | null {
  if (process.platform !== 'win32') {
    return null
  }
  const sourceWsl = parseWslUncPath(sourcePath)
  const targetWsl = parseWslUncPath(targetPath)
  if (!sourceWsl || !targetWsl || sourceWsl.distro !== targetWsl.distro) {
    return null
  }
  return {
    distro: sourceWsl.distro,
    sourceLinuxPath: sourceWsl.linuxPath,
    targetLinuxPath: targetWsl.linuxPath
  }
}

function runWslPathCommand(distro: string, args: string[]): boolean {
  try {
    execFileSync('wsl.exe', ['-d', distro, '--', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000
    })
    return true
  } catch {
    return false
  }
}

function wslPathExists(targetPath: string): boolean | null {
  if (process.platform !== 'win32') {
    return null
  }
  const targetWsl = parseWslUncPath(targetPath)
  if (!targetWsl) {
    return null
  }
  return runWslPathCommand(targetWsl.distro, [
    'sh',
    '-c',
    'test -e "$1" || test -L "$1"',
    'sh',
    targetWsl.linuxPath
  ])
}

function removeWslPathIfPossible(targetPath: string): boolean {
  if (process.platform !== 'win32') {
    return false
  }
  const targetWsl = parseWslUncPath(targetPath)
  if (!targetWsl) {
    return false
  }
  return runWslPathCommand(targetWsl.distro, ['rm', '-rf', '--', targetWsl.linuxPath])
}

function readWslSymlinkTarget(targetPath: string): string | null {
  if (process.platform !== 'win32') {
    return null
  }
  const targetWsl = parseWslUncPath(targetPath)
  if (!targetWsl) {
    return null
  }
  try {
    return execFileSync(
      'wsl.exe',
      ['-d', targetWsl.distro, '--', 'readlink', targetWsl.linuxPath],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000
      }
    ).trim()
  } catch {
    return null
  }
}

function copyFallbackAllowed(sourcePath: string, entryName: string): boolean {
  if (entryName === 'hooks.json') {
    return false
  }
  const sourceStat = lstatSync(sourcePath)
  return !sourceStat.isDirectory() || !MUTABLE_SHARED_DIRECTORY_ENTRIES.has(entryName)
}

function isContainedPath(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(resolve(rootPath), resolve(candidatePath))
  return (
    Boolean(relativePath) &&
    relativePath !== '..' &&
    !isAbsolute(relativePath) &&
    !relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  )
}

function reconcileMutableLaunchHomeFilesIntoSharedHome(
  sharedHomePath: string,
  launchRootPath: string
): void {
  let selectionEntries: string[]
  try {
    selectionEntries = readdirSync(launchRootPath)
  } catch {
    return
  }
  for (const selectionEntry of selectionEntries.sort()) {
    const launchHomePath = join(launchRootPath, selectionEntry, 'home')
    if (!existsSync(join(launchHomePath, LAUNCH_HOME_MARKER))) {
      continue
    }
    reconcileMarkedMutableFiles(sharedHomePath, launchHomePath)
  }
}

function reconcileMarkedMutableFiles(sharedHomePath: string, launchHomePath: string): void {
  const markerDir = join(launchHomePath, LAUNCH_HOME_LINK_MARKERS_DIR)
  let markerFiles: string[]
  try {
    markerFiles = readdirSync(markerDir)
  } catch {
    return
  }
  for (const markerFile of markerFiles.sort()) {
    const entryName = markerFile.replace(/\.json$/, '')
    const marker = readLaunchEntryMarker(launchHomePath, entryName)
    if (!marker || !MUTABLE_SHARED_FILE_ENTRIES.has(entryName)) {
      continue
    }
    if (marker.sourcePath !== join(sharedHomePath, entryName)) {
      continue
    }
    reconcileMutableLaunchEntryIfNeeded(marker.sourcePath, join(launchHomePath, entryName), marker)
  }
}

function reconcileMutableLaunchEntryIfNeeded(
  sourcePath: string,
  targetPath: string,
  marker: LaunchEntryMarker | null
): void {
  if (!marker || !MUTABLE_SHARED_FILE_ENTRIES.has(targetPath.split(/[\\/]/).at(-1) ?? '')) {
    return
  }
  if (!targetExistsForLaunchRemoval(targetPath)) {
    return
  }
  if (targetAlreadyPointsToSource(targetPath, sourcePath)) {
    return
  }
  try {
    if (lstatSync(targetPath).isSymbolicLink() || !statSync(targetPath).isFile()) {
      return
    }
    const targetDigest = digestFile(targetPath)
    if (targetDigest === marker.targetDigest) {
      return
    }
    const sourceDigest = existsSync(sourcePath) ? digestFile(sourcePath) : null
    if (
      sourceDigest !== null &&
      marker.sourceDigest !== null &&
      sourceDigest !== marker.sourceDigest &&
      statSync(sourcePath).mtimeMs > statSync(targetPath).mtimeMs
    ) {
      return
    }
    mkdirSync(dirname(sourcePath), { recursive: true })
    cpSync(targetPath, sourcePath, { force: true })
  } catch (error) {
    console.warn('[codex-home] Failed to reconcile launch-home Codex entry:', targetPath, error)
  }
}

function removeStaleLaunchHomeEntries(
  launchHomePath: string,
  sharedHomePath: string,
  sharedEntries: Set<string>
): void {
  const markerDir = join(launchHomePath, LAUNCH_HOME_LINK_MARKERS_DIR)
  let markerFiles: string[]
  try {
    markerFiles = readdirSync(markerDir)
  } catch {
    return
  }
  for (const markerFile of markerFiles) {
    const entryName = markerFile.replace(/\.json$/, '')
    if (!sharedEntries.has(entryName)) {
      removeLaunchEntryIfOwned(
        join(launchHomePath, entryName),
        launchHomePath,
        entryName,
        join(sharedHomePath, entryName)
      )
    }
  }
}

function removeLaunchEntryIfOwned(
  targetPath: string,
  launchHomePath: string,
  entryName: string,
  sourcePath: string
): void {
  const marker = readLaunchEntryMarker(launchHomePath, entryName)
  if (marker?.sourcePath !== sourcePath) {
    return
  }
  removeLaunchEntry(targetPath)
  rmSync(getLaunchEntryMarkerPath(launchHomePath, entryName), { force: true })
}

function removeLaunchEntry(targetPath: string): void {
  if (!targetExistsForLaunchRemoval(targetPath)) {
    return
  }
  try {
    if (removeWslPathIfPossible(targetPath)) {
      return
    }
    const stat = lstatSync(targetPath)
    if (stat.isSymbolicLink()) {
      try {
        unlinkSync(targetPath)
      } catch (error) {
        if (process.platform !== 'win32') {
          throw error
        }
        rmdirSync(targetPath)
      }
      return
    }
    rmSync(targetPath, { recursive: stat.isDirectory(), force: true })
  } catch (error) {
    console.warn('[codex-home] Failed to remove owned launch-home entry:', targetPath, error)
  }
}

function targetExistsForLaunchRemoval(targetPath: string): boolean {
  const wslExists = wslPathExists(targetPath)
  if (wslExists !== null) {
    return wslExists
  }
  try {
    lstatSync(targetPath)
    return true
  } catch {
    return false
  }
}

function writeLaunchHomeMarker(launchHomePath: string, accountId: string | null): void {
  writeFileSync(
    join(launchHomePath, LAUNCH_HOME_MARKER),
    `${JSON.stringify({ version: LAUNCH_HOME_MARKER_VERSION, accountId }, null, 2)}\n`,
    { encoding: 'utf-8', mode: 0o600 }
  )
}

function isMarkedLaunchHomeForAccount(launchHomePath: string, accountId: string): boolean {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(launchHomePath, LAUNCH_HOME_MARKER), 'utf-8')
    )
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false
    }
    const marker = parsed as { version?: unknown; accountId?: unknown }
    return marker.version === LAUNCH_HOME_MARKER_VERSION && marker.accountId === accountId
  } catch {
    return false
  }
}

function markLaunchEntry(
  launchHomePath: string,
  entryName: string,
  sourcePath: string,
  mode: 'link' | 'copy'
): void {
  const markerPath = getLaunchEntryMarkerPath(launchHomePath, entryName)
  mkdirSync(dirname(markerPath), { recursive: true })
  writeFileSync(
    markerPath,
    `${JSON.stringify(
      {
        version: LAUNCH_HOME_MARKER_VERSION,
        sourcePath,
        mode,
        sourceDigest: digestPathIfFile(sourcePath),
        targetDigest: digestPathIfFile(join(launchHomePath, entryName))
      } satisfies LaunchEntryMarker,
      null,
      2
    )}\n`,
    { encoding: 'utf-8', mode: 0o600 }
  )
}

function readLaunchEntryMarker(
  launchHomePath: string,
  entryName: string
): LaunchEntryMarker | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(getLaunchEntryMarkerPath(launchHomePath, entryName), 'utf-8')
    )
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const marker = parsed as Partial<LaunchEntryMarker>
    if (
      marker.version !== LAUNCH_HOME_MARKER_VERSION ||
      typeof marker.sourcePath !== 'string' ||
      (marker.mode !== 'link' && marker.mode !== 'copy')
    ) {
      return null
    }
    return {
      version: marker.version,
      sourcePath: marker.sourcePath,
      mode: marker.mode,
      sourceDigest: typeof marker.sourceDigest === 'string' ? marker.sourceDigest : null,
      targetDigest: typeof marker.targetDigest === 'string' ? marker.targetDigest : null
    }
  } catch {
    return null
  }
}

function targetAlreadyPointsToSource(targetPath: string, sourcePath: string): boolean {
  const paths = getSameDistroWslPaths(sourcePath, targetPath)
  if (paths) {
    return readWslSymlinkTarget(targetPath) === paths.sourceLinuxPath
  }
  try {
    return (
      lstatSync(targetPath).isSymbolicLink() &&
      linkTargetsMatch(readlinkSync(targetPath), sourcePath)
    )
  } catch {
    return false
  }
}

function linkTargetsMatch(actualTarget: string, expectedTarget: string): boolean {
  const expectedWsl = parseWslUncPath(expectedTarget)
  if (expectedWsl && actualTarget === expectedWsl.linuxPath) {
    return true
  }
  if (process.platform !== 'win32') {
    return actualTarget === expectedTarget
  }
  return normalizeWindowsLinkTarget(actualTarget) === normalizeWindowsLinkTarget(expectedTarget)
}

function normalizeWindowsLinkTarget(linkTarget: string): string {
  return linkTarget.replace(/^\\\\\?\\/, '').toLowerCase()
}

function getLaunchEntryMarkerPath(launchHomePath: string, entryName: string): string {
  return join(launchHomePath, LAUNCH_HOME_LINK_MARKERS_DIR, `${entryName}.json`)
}

function digestPathIfFile(targetPath: string): string | null {
  try {
    if (!statSync(targetPath).isFile()) {
      return null
    }
    return digestFile(targetPath)
  } catch {
    return null
  }
}

function digestFile(targetPath: string): string {
  return createHash('sha256').update(readFileSync(targetPath)).digest('hex')
}
