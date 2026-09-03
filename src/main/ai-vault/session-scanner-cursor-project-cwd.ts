import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractString, parseJsonObject } from './session-scanner-values'

/**
 * Cursor legacy transcripts live under:
 *   ~/.cursor/projects/<slug>/agent-transcripts/...
 * JSONL rows do not carry cwd. Resolve the workspace from the project bucket:
 * prefer `.workspace-trusted` (Cursor + Orca trust marker), else decode the slug.
 */
export function resolveCursorTranscriptCwd(filePath: string): string | null {
  const projectDir = cursorProjectDirFromTranscriptPath(filePath)
  if (!projectDir) {
    return null
  }
  const slug = pathLeaf(projectDir)
  return readCursorWorkspaceTrustedPath(projectDir) ?? decodeCursorProjectSlug(slug)
}

/** Walk parents with both `/` and `\` so Windows transcript paths parse on any host. */
export function cursorProjectDirFromTranscriptPath(filePath: string): string | null {
  const segments = splitPathSegments(filePath)
  const marker = segments.lastIndexOf('agent-transcripts')
  if (marker < 1) {
    return null
  }
  return joinPathSegments(segments.slice(0, marker), filePath)
}

function splitPathSegments(filePath: string): string[] {
  return filePath.split(/[\\/]+/).filter(Boolean)
}

function pathLeaf(filePath: string): string {
  const segments = splitPathSegments(filePath)
  return segments[segments.length - 1] ?? ''
}

function joinPathSegments(segments: string[], originalPath: string): string {
  if (segments.length === 0) {
    return originalPath.startsWith('/') ? '/' : ''
  }
  const useBackslash = originalPath.includes('\\') && !originalPath.includes('/')
  const joined = segments.join(useBackslash ? '\\' : '/')
  // Preserve absolute POSIX prefix; Windows drive is already the first segment.
  if (originalPath.startsWith('/') && !/^[A-Za-z]:/.test(segments[0] ?? '')) {
    return `/${joined}`
  }
  return joined
}

export function readCursorWorkspaceTrustedPath(projectDir: string): string | null {
  const trustFile = join(projectDir, '.workspace-trusted')
  if (!existsSync(trustFile)) {
    return null
  }
  try {
    const record = parseJsonObject(readFileSync(trustFile, 'utf-8'))
    const workspacePath = extractString(record?.workspacePath)?.trim()
    return workspacePath || null
  } catch {
    return null
  }
}

/**
 * Inverse of Cursor/Orca project slugging (`/` `\` `:` and other reserved
 * path chars → `-`). Lossy when a path segment itself contains `-`; prefer
 * `.workspace-trusted` when present.
 */
export function decodeCursorProjectSlug(slug: string): string | null {
  const trimmed = slug.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..') {
    return null
  }
  const windowsDrive = trimmed.match(/^([A-Za-z])-(.+)$/)
  if (windowsDrive) {
    const drive = windowsDrive[1].toUpperCase()
    const rest = windowsDrive[2].replace(/-/g, '\\')
    return `${drive}:\\${rest}`
  }
  // POSIX absolute path with leading `/` stripped by Cursor's slugger.
  return `/${trimmed.replace(/-/g, '/')}`
}
