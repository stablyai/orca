import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AiVaultAgent, AiVaultSession } from '../../shared/ai-vault-types'
import { isWslUncPath } from '../../shared/wsl-paths'
import {
  cursorProjectSlugFromTranscriptPath,
  decodeCursorProjectSlug
} from '../../shared/cursor-workspace-slug'
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
  const projectDir = cursorProjectDirFromTranscriptPath(filePath)
  // Why: never raw-read WSL UNC 9P or a remote host path as if it were local.
  if (options.readTrustFile !== false && projectDir && !isWslUncPath(filePath)) {
    const trusted = readCachedTrustedWorkspacePath(projectDir)
    if (trusted) {
      return trusted
    }
  }
  // Why: inverse slug decode is lossy for hyphenated folder names. Only publish
  // it as cwd when the reconstructed path actually exists on this host.
  if (options.readTrustFile === false || isWslUncPath(filePath)) {
    return null
  }
  const decoded = decodeCursorProjectSlug(slug)
  return decoded && existsSync(decoded) ? decoded : null
}

export function cursorProjectDirFromTranscriptPath(filePath: string): string | null {
  if (!cursorProjectSlugFromTranscriptPath(filePath)) {
    return null
  }
  const segments = filePath.split(/[\\/]+/).filter(Boolean)
  const marker = segments.lastIndexOf('agent-transcripts')
  return joinPathSegments(segments.slice(0, marker), filePath)
}

function readCachedTrustedWorkspacePath(projectDir: string): string | null {
  if (trustedCwdCache.has(projectDir)) {
    return trustedCwdCache.get(projectDir) ?? null
  }
  const cwd =
    readCursorWorkspaceTrustedPath(projectDir) ??
    readCursorWorkspaceTrustedPath(driveCaseSiblingProjectDir(projectDir))
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
    const record = parseJsonObject(readFileSync(join(projectDir, '.workspace-trusted'), 'utf-8'))
    return extractString(record?.workspacePath)?.trim() || null
  } catch {
    return null
  }
}

function driveCaseSiblingProjectDir(projectDir: string): string | null {
  const segments = projectDir.split(/[\\/]+/).filter(Boolean)
  const slug = segments.at(-1)
  if (!slug) {
    return null
  }
  const flipped = slug.replace(/^([A-Za-z])-/, (_, drive: string) => {
    const next = drive === drive.toLowerCase() ? drive.toUpperCase() : drive.toLowerCase()
    return `${next}-`
  })
  if (flipped === slug) {
    return null
  }
  segments[segments.length - 1] = flipped
  return joinPathSegments(segments, projectDir)
}

function joinPathSegments(segments: string[], originalPath: string): string {
  if (segments.length === 0) {
    return originalPath.startsWith('/') ? '/' : ''
  }
  const useBackslash = originalPath.includes('\\') && !originalPath.includes('/')
  const joined = segments.join(useBackslash ? '\\' : '/')
  if (originalPath.startsWith('/') && !/^[A-Za-z]:/.test(segments[0] ?? '')) {
    return `/${joined}`
  }
  return joined
}
