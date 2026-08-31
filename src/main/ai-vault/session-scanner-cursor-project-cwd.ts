import { readFileSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import type { AiVaultAgent, AiVaultSession } from '../../shared/ai-vault-types'
import {
  cursorProjectSlugFromTranscriptPath,
  isCursorTranscriptInWorkspace
} from '../../shared/cursor-workspace-slug'
import { isRuntimePathAbsolute, isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { isWslUncPath } from '../../shared/wsl-paths'
import { extractString, parseJsonObject } from './session-scanner-values'

const TRUSTED_CWD_CACHE_MAX = 2048
const trustedCwdCache = new Map<string, string | null>()

export function resetCursorTrustedCwdCache(): void {
  trustedCwdCache.clear()
}

export function resetCursorTrustedCwdCacheForTests(): void {
  resetCursorTrustedCwdCache()
}

export function refreshCachedCursorCwd(session: AiVaultSession): AiVaultSession {
  const cwd = resolveCursorTranscriptCwd(session.filePath)
  return cwd === session.cwd ? session : { ...session, cwd }
}

export function maybeRefreshCachedCursorCwd(
  agent: AiVaultAgent,
  session: AiVaultSession | null
): AiVaultSession | null {
  return agent === 'cursor' && session ? refreshCachedCursorCwd(session) : session
}

export function resolveCursorTranscriptCwd(
  filePath: string,
  options: { readTrustFile?: boolean } = {}
): string | null {
  const slug = cursorProjectSlugFromTranscriptPath(filePath)
  if (!slug) {
    return null
  }
  if (options.readTrustFile === false || isWslUncPath(filePath)) {
    return null
  }
  const projectDir = cursorProjectDirFromTranscriptPath(filePath)
  if (!projectDir) {
    return null
  }
  return readCachedTrustedWorkspacePath(projectDir, filePath, slug)
}

export function cursorProjectDirFromTranscriptPath(filePath: string): string | null {
  if (!cursorProjectSlugFromTranscriptPath(filePath)) {
    return null
  }
  const pathApi = pathImplementation(filePath)
  let current = pathApi.normalize(filePath)
  while (true) {
    if (pathApi.basename(current) === 'agent-transcripts') {
      return pathApi.dirname(current)
    }
    const parent = pathApi.dirname(current)
    if (parent === current) {
      return null
    }
    current = parent
  }
}

function readCachedTrustedWorkspacePath(
  projectDir: string,
  filePath: string,
  slug: string
): string | null {
  if (trustedCwdCache.has(projectDir)) {
    return trustedCwdCache.get(projectDir) ?? null
  }
  const primary = readCursorWorkspaceTrustedPath(projectDir)
  let cwd = isTrustedWorkspacePath(primary, projectDir, filePath) ? primary : null
  if (!cwd) {
    const siblingProjectDir = driveCaseSiblingProjectDir(projectDir)
    const siblingWorkspacePath = siblingProjectDir
      ? readCursorWorkspaceTrustedPath(siblingProjectDir)
      : null
    cwd = isTrustedDriveSiblingWorkspacePath(siblingWorkspacePath, projectDir, filePath, slug)
      ? siblingWorkspacePath
      : null
  }
  if (trustedCwdCache.size >= TRUSTED_CWD_CACHE_MAX) {
    const oldest = trustedCwdCache.keys().next()
    if (!oldest.done) {
      trustedCwdCache.delete(oldest.value)
    }
  }
  trustedCwdCache.set(projectDir, cwd)
  return cwd
}

function readCursorWorkspaceTrustedPath(projectDir: string | null): string | null {
  if (!projectDir) {
    return null
  }
  try {
    const record = parseJsonObject(
      readFileSync(pathImplementation(projectDir).join(projectDir, '.workspace-trusted'), 'utf-8')
    )
    return extractString(record?.workspacePath)?.trim() || null
  } catch {
    return null
  }
}

function driveCaseSiblingProjectDir(projectDir: string): string | null {
  if (!isWindowsAbsolutePathLike(projectDir) || isWslUncPath(projectDir)) {
    return null
  }
  const slug = win32.basename(projectDir)
  const driveMatch = slug.match(/^([A-Za-z])-/)
  if (!driveMatch) {
    return null
  }
  const drive = driveMatch[1]
  const flippedDrive = drive === drive.toLowerCase() ? drive.toUpperCase() : drive.toLowerCase()
  return win32.join(win32.dirname(projectDir), `${flippedDrive}${slug.slice(1)}`)
}

function isTrustedWorkspacePath(
  workspacePath: string | null,
  projectDir: string,
  filePath: string
): workspacePath is string {
  if (!workspacePath) {
    return false
  }
  const projectIsWindows = isWindowsAbsolutePathLike(projectDir)
  const workspaceIsWindows = isWindowsAbsolutePathLike(workspacePath)
  if (projectIsWindows !== workspaceIsWindows) {
    return false
  }
  const pathFlavor = workspaceIsWindows ? 'windows' : 'posix'
  return (
    isRuntimePathAbsolute(workspacePath, pathFlavor) &&
    isCursorTranscriptInWorkspace(workspacePath, filePath)
  )
}

function isTrustedDriveSiblingWorkspacePath(
  workspacePath: string | null,
  projectDir: string,
  filePath: string,
  slug: string
): workspacePath is string {
  if (!isTrustedWorkspacePath(workspacePath, projectDir, filePath)) {
    return false
  }
  const slugDrive = slug.match(/^([A-Za-z])-/)?.[1]
  const workspaceDrive = workspacePath.match(/^([A-Za-z]):[\\/]/)?.[1]
  return Boolean(
    slugDrive && workspaceDrive && slugDrive.toLowerCase() === workspaceDrive.toLowerCase()
  )
}

function pathImplementation(value: string): typeof posix {
  return isWindowsAbsolutePathLike(value) ? win32 : posix
}
