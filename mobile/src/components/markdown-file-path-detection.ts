// Conservative detection of file-path-like tokens inside an inline markdown text
// run, so the chat view can render them as tappable (opening the mobile file
// viewer). We deliberately favor precision over recall: a missed path is a minor
// annoyance, but a false positive on prose or a version number is a broken tap.

export type FilePathSegment =
  | { type: 'text'; value: string }
  | { type: 'file'; value: string; path: string }

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

// Accept the host's native separator because transcript paths originate on the
// connected runtime, which may be Windows even when the phone is not.
const CANDIDATE_PATTERN =
  /(?:[A-Za-z]:[\\/]|\\\\)?(?:\.{1,2}[\\/])?(?:[\w.@~+-]+[\\/])+[\w.@+-]+\.[A-Za-z0-9]+/g

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

function isOpenablePath(candidate: string): boolean {
  // Reject anything URL-ish or scheme-bearing — those are handled as web links.
  if (candidate.includes('://') || hasMidTokenAt(candidate)) {
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
  let match: RegExpExecArray | null
  CANDIDATE_PATTERN.lastIndex = 0

  while ((match = CANDIDATE_PATTERN.exec(text))) {
    const candidate = match[0]
    // Skip candidates that are part of a URL (preceded by a scheme colon or an
    // alphanumeric/host char that would make this a domain tail, not a path).
    const prev = match.index > 0 ? text[match.index - 1]! : ''
    if (prev === ':' || prev === '/' || /[\w.@]/.test(prev)) {
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
  if (!trimmed || /\s/.test(trimmed)) {
    return false
  }
  if (trimmed.includes('://') || hasMidTokenAt(trimmed)) {
    return false
  }
  if (isOpenablePath(trimmed)) {
    return true
  }
  // Separator-less code span: accept a clean name.ext with a known extension.
  if (/[\\/]/.test(trimmed)) {
    return false
  }
  const dot = trimmed.lastIndexOf('.')
  if (dot <= 0) {
    return false
  }
  const name = trimmed.slice(0, dot)
  const ext = trimmed.slice(dot + 1).toLowerCase()
  if (/[^\w.@+-]/.test(name)) {
    return false
  }
  return EXTENSION_SET.has(ext)
}
