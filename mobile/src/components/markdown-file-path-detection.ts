// Prefer precise chat file paths over recall: missed link is tolerable, false prose/version tap is broken navigation.

import { parseFileLinkLocation } from '../../../src/shared/file-link-location'

export type FilePathSegment =
  | { type: 'text'; value: string }
  | { type: 'file'; value: string; path: string }

// Allow explicit source/config extensions, not arbitrary suffixes that match prose abbreviations or domains.
const FILE_EXTENSIONS = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'jsonc',
  'css',
  'scss',
  'sass',
  'less',
  'html',
  'htm',
  'md',
  'mdx',
  'markdown',
  'txt',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'php',
  'sh',
  'bash',
  'zsh',
  'fish',
  'yml',
  'yaml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'lock',
  'sql',
  'graphql',
  'gql',
  'proto',
  'xml',
  'svg',
  'vue',
  'svelte',
  'astro',
  'dart',
  'ex',
  'exs',
  'erl',
  'lua',
  'pl',
  'r',
  'scala',
  'clj',
  'gradle',
  'dockerfile',
  'gitignore',
  'npmrc'
] as const

const EXTENSION_SET = new Set<string>(FILE_EXTENSIONS)

// Accept host-native Windows drives/UNC/POSIX paths regardless of phone OS, plus bounded trailing :line(:col).
const CANDIDATE_PATTERN =
  /(?:(?:[A-Za-z]:[\\/]|\\\\|[\\/]|\.{1,2}[\\/])(?:[\w.@~+-]+[\\/])*|(?:[\w.@~+-]+[\\/])+)[\w.@+-]+\.[A-Za-z0-9]+(?::[1-9]\d*(?::[1-9]\d*)?(?![\w@%]))?/g

// Skip overlong inline runs to bound candidate regex’s super-linear backtracking.
const MAX_DETECTION_LENGTH = 2000

// Mid-token @ marks email/git URL; segment-leading @scope remains eligible package path.
function hasMidTokenAt(candidate: string): boolean {
  return /[^\\/]@/.test(candidate)
}

// Split trailing numeric :line(:col); preserve Windows drive colon.
export function splitFilePathLineSuffix(pathText: string): {
  path: string
  line: number | null
  column: number | null
} {
  const parsed = parseFileLinkLocation(pathText)
  if (!parsed || (parsed.line === null && parsed.column === null)) {
    return { path: pathText, line: null, column: null }
  }
  return {
    path: parsed.pathText,
    line: parsed.line,
    column: parsed.column
  }
}

function isOpenablePath(pathText: string): boolean {
  const { path: candidate } = splitFilePathLineSuffix(pathText)
  if (candidate.includes('://') || hasMidTokenAt(candidate)) {
    return false
  }
  if (!/[\\/]/.test(candidate)) {
    return false
  }
  const lastSeparator = Math.max(candidate.lastIndexOf('/'), candidate.lastIndexOf('\\'))
  const lastSegment = candidate.slice(lastSeparator + 1)
  const dot = lastSegment.lastIndexOf('.')
  // Require real name.ext in final segment; bare dotfiles lack reliable extension signal.
  if (dot <= 0) {
    return false
  }
  const ext = lastSegment.slice(dot + 1).toLowerCase()
  if (!EXTENSION_SET.has(ext)) {
    return false
  }
  // Reject purely numeric extension so version tails do not become file links.
  if (/^\d+$/.test(ext)) {
    return false
  }
  return true
}

// Remove ./ for clean worktree-relative path; preserve meaningful ../.
export function normalizeFilePath(path: string): string {
  return path.replace(/^\.[\\/]/, '')
}

// Return ordered path/plain-text segments preserving every input character, or one plain segment on no match.
export function detectFilePathSegments(text: string): FilePathSegment[] {
  // Skip regex without dot or above length cap; all valid names need dot and long runs risk super-linear backtracking.
  if (text.length > MAX_DETECTION_LENGTH || !text.includes('.')) {
    return [{ type: 'text', value: text }]
  }
  const segments: FilePathSegment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  CANDIDATE_PATTERN.lastIndex = 0

  while ((match = CANDIDATE_PATTERN.exec(text))) {
    const candidate = match[0]
    // Exclude scheme/domain/preceding-slash URL remnants; genuine absolute path’s leading slash is already in match.
    const prev = match.index > 0 ? text[match.index - 1]! : ''
    if (prev === ':' || prev === '/' || prev === '\\' || /[\w.@]/.test(prev)) {
      continue
    }
    if (!isOpenablePath(candidate)) {
      continue
    }
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, match.index) })
    }
    segments.push({ type: 'file', value: candidate, path: normalizeFilePath(candidate) })
    lastIndex = match.index + candidate.length
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) })
  }
  if (segments.length === 0) {
    return [{ type: 'text', value: text }]
  }
  return segments
}

// Inline-code context permits bare known-extension file.ts (with optional line/column), unlike ambiguous prose.
export function isFilePathCodeSpan(code: string): boolean {
  const trimmed = code.trim()
  if (!trimmed || /\s/.test(trimmed)) {
    return false
  }
  if (trimmed.includes('://') || hasMidTokenAt(trimmed)) {
    return false
  }
  if (isOpenablePath(trimmed)) {
    return true
  }
  // Accept clean name.ext with known extension and optional citation tail in separator-less code spans.
  const { path } = splitFilePathLineSuffix(trimmed)
  if (/[\\/]/.test(path)) {
    return false
  }
  const dot = path.lastIndexOf('.')
  if (dot <= 0) {
    return false
  }
  const name = path.slice(0, dot)
  const ext = path.slice(dot + 1).toLowerCase()
  if (/[^\w.@+-]/.test(name)) {
    return false
  }
  return EXTENSION_SET.has(ext)
}
