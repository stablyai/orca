import { parseMobileFileTapTarget, type MobileFileTapTarget } from '../files/mobile-file-tap-target'

// Conservative detection of file-path-like tokens inside an inline markdown text
// run, so the chat view can render them as tappable (opening the mobile file
// viewer). We deliberately favor precision over recall: a missed path is a minor
// annoyance, but a false positive on prose or a version number is a broken tap.

export type FilePathSegment =
  | { type: 'text'; value: string }
  | { type: 'file'; value: string; target: MobileFileTapTarget }

// Common source/code/config extensions we treat as openable file paths. Kept
// explicit (rather than "any extension") so prose like "etc." or "e.g." and
// domain-ish tokens like "example.com" don't get matched.
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
const EXTENSIONLESS_FILENAMES = new Set([
  'dockerfile',
  'makefile',
  'procfile',
  'rakefile',
  'gemfile',
  'justfile',
  'brewfile',
  'jenkinsfile',
  'vagrantfile',
  'codeowners'
])

// Accept the host's native separator because transcript paths originate on the
// connected runtime, which may be Windows even when the phone is not.
const CANDIDATE_PATTERN =
  /^(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[\p{L}\p{N}_.@~+()[\]-]+[\\/])[\p{L}\p{N}_.@~+/%\\()[\]-]+\.[A-Za-z0-9]+(?::\d+)?(?::\d+)?$/u
const TOKEN_PATTERN = /\S+/g
const LEADING_PUNCTUATION = /^[<'"`]+/
const TRAILING_PUNCTUATION = /[>'"`,.;:!?]+$/
const DOMAIN_LIKE_SEGMENT = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i

// A path candidate in chat prose is short; a much longer run can't hold one worth
// linkifying but can push CANDIDATE_PATTERN into super-linear backtracking, so we
// skip detection entirely above this cap.
const MAX_DETECTION_LENGTH = 2000

// A mid-token '@' (one preceded by a non-separator) marks an email or git URL such
// as git@github.com; a segment-leading '@' is a scoped package dir (@scope/…) and
// stays eligible.
function hasMidTokenAt(candidate: string): boolean {
  return /[^\\/]@/.test(candidate)
}

function hasDomainLikeFirstSegment(pathText: string): boolean {
  if (/^(?:[\\/~]|\.{1,2}[\\/]|[A-Za-z]:[\\/])/.test(pathText)) {
    return false
  }
  return DOMAIN_LIKE_SEGMENT.test(pathText.split(/[\\/]/)[0] ?? '')
}

function hasBalancedRouteDelimiters(value: string): boolean {
  for (const [open, close] of [
    ['(', ')'],
    ['[', ']']
  ]) {
    let depth = 0
    for (const char of value) {
      if (char === open) {
        depth += 1
      } else if (char === close && --depth < 0) {
        return false
      }
    }
    if (depth !== 0) {
      return false
    }
  }
  return true
}

function trimTokenPunctuation(rawToken: string): {
  candidate: string
  leadingLength: number
} {
  const leading = LEADING_PUNCTUATION.exec(rawToken)?.[0].length ?? 0
  const withoutLeading = rawToken.slice(leading)
  const trailing = TRAILING_PUNCTUATION.exec(withoutLeading)?.[0].length ?? 0
  let candidate = trailing > 0 ? withoutLeading.slice(0, -trailing) : withoutLeading
  let wrapperLength = 0
  while (
    (candidate.startsWith('(') && candidate.endsWith(')')) ||
    (candidate.startsWith('[') && candidate.endsWith(']')) ||
    (candidate.startsWith('{') && candidate.endsWith('}'))
  ) {
    candidate = candidate.slice(1, -1)
    wrapperLength += 1
  }
  return { candidate, leadingLength: leading + wrapperLength }
}

function decodeDetectedPath(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function isOpenablePath(candidate: string): boolean {
  // Reject anything URL-ish or scheme-bearing — those are handled as web links.
  if (
    candidate.includes('://') ||
    hasMidTokenAt(candidate) ||
    hasDomainLikeFirstSegment(candidate) ||
    !hasBalancedRouteDelimiters(candidate)
  ) {
    return false
  }
  // Must contain a separator (a bare "file.ts" is too ambiguous in prose).
  if (!/[\\/]/.test(candidate)) {
    return false
  }
  const lastSeparator = Math.max(candidate.lastIndexOf('/'), candidate.lastIndexOf('\\'))
  const lastSegment = candidate.slice(lastSeparator + 1)
  const dot = lastSegment.lastIndexOf('.')
  // A leading-dot dotfile in the final segment (e.g. ".env") has no extension to
  // anchor on; require a real name.ext shape.
  if (dot <= 0) {
    return false
  }
  const ext = lastSegment.slice(dot + 1).toLowerCase()
  if (!EXTENSION_SET.has(ext)) {
    return false
  }
  // Guard against version-number-ish tails ("1.2.3" style) where the "extension"
  // is purely numeric — those aren't files.
  if (/^\d+$/.test(ext)) {
    return false
  }
  return true
}

// Strip the leading ./ marker so callers receive a clean worktree-relative path,
// while keeping ../ (which is meaningful) intact.
export function normalizeFilePath(path: string): string {
  return path.replace(/^\.[\\/]/, '')
}

/**
 * Given a plain inline text run, return ordered segments marking which substrings
 * are openable file paths. Non-path text is preserved verbatim so the renderer can
 * reassemble the run exactly. Returns a single text segment when nothing matches.
 */
export function detectFilePathSegments(text: string): FilePathSegment[] {
  // Every real match ends in a name.ext, so a dot is mandatory; skip the regex when
  // there is none, or when the run is too long to hold a chat path but long enough
  // to drive CANDIDATE_PATTERN into super-linear backtracking.
  if (text.length > MAX_DETECTION_LENGTH || !text.includes('.')) {
    return [{ type: 'text', value: text }]
  }
  const segments: FilePathSegment[] = []
  let lastIndex = 0
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const rawToken = match[0]
    const { candidate, leadingLength } = trimTokenPunctuation(rawToken)
    const candidateIndex = match.index + leadingLength
    if (!candidate || !CANDIDATE_PATTERN.test(candidate)) {
      continue
    }
    const previousToken = text.slice(0, match.index).trimEnd().match(/\S+$/)?.[0] ?? ''
    const previousIsCompletePath =
      CANDIDATE_PATTERN.test(previousToken) &&
      Boolean(
        parseMobileFileTapTarget(previousToken) &&
        isOpenablePath(parseMobileFileTapTarget(previousToken)!.pathText)
      )
    const candidateFirstSegment = candidate.split(/[\\/]/)[0] ?? ''
    const looksLikeSpacedRelativePath =
      /^[\p{L}\p{N}_-]+$/u.test(previousToken) &&
      /^[A-Z][\p{L}\p{N}_-]*$/u.test(candidateFirstSegment)
    if (
      (/[\\/]/.test(previousToken) || looksLikeSpacedRelativePath) &&
      !previousIsCompletePath &&
      !/[.!?:;,]$/.test(previousToken)
    ) {
      continue
    }
    const parsed = parseMobileFileTapTarget(candidate)
    const decodedPath = parsed ? decodeDetectedPath(parsed.pathText) : null
    if (!parsed || !decodedPath || !isOpenablePath(decodedPath)) {
      continue
    }
    if (candidateIndex > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, candidateIndex) })
    }
    segments.push({
      type: 'file',
      value: candidate,
      target: { ...parsed, pathText: normalizeFilePath(decodedPath) }
    })
    lastIndex = candidateIndex + candidate.length
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) })
  }
  // Collapse to a single text segment for the common no-match case.
  if (segments.length === 0) {
    return [{ type: 'text', value: text }]
  }
  return segments
}

/**
 * True when an inline-code span's entire content is a single openable file path
 * (e.g. `src/app/Main.tsx`). Code spans are a strong signal, so we also accept a
 * bare `file.ts` here even without a slash.
 */
export function isFilePathCodeSpan(code: string): boolean {
  const trimmed = code.trim()
  if (!trimmed || /[\r\n]/.test(trimmed)) {
    return false
  }
  const parsed = parseMobileFileTapTarget(trimmed)
  if (
    !parsed ||
    parsed.pathText.includes('://') ||
    hasMidTokenAt(parsed.pathText) ||
    !hasBalancedRouteDelimiters(parsed.pathText)
  ) {
    return false
  }
  if (isOpenablePath(parsed.pathText)) {
    return true
  }
  const lastSeparator = Math.max(
    parsed.pathText.lastIndexOf('/'),
    parsed.pathText.lastIndexOf('\\')
  )
  const lastSegment = parsed.pathText.slice(lastSeparator + 1)
  if (!lastSegment) {
    return false
  }
  if (EXTENSIONLESS_FILENAMES.has(lastSegment.toLowerCase())) {
    return true
  }
  if (/^\.[\w-]+$/.test(lastSegment)) {
    return true
  }
  const dot = lastSegment.lastIndexOf('.')
  if (dot <= 0) {
    return false
  }
  const name = lastSegment.slice(0, dot)
  const ext = lastSegment.slice(dot + 1).toLowerCase()
  if (/[^\w.@+-]/.test(name)) {
    return false
  }
  if (/^\d+$/.test(ext)) {
    return false
  }
  return lastSeparator >= 0 ? /^[a-z0-9]+$/i.test(ext) : EXTENSION_SET.has(ext)
}
