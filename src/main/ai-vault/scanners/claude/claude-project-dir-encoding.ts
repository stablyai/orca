import { normalizeRuntimePathSeparators } from '../../../../shared/cross-platform-path'

/** Encode case-preserving raw paths and NFC variants; comparison keys lose Windows case and macOS can supply NFD. */
export function encodeClaudeProjectPaths(pathValue: string): string[] {
  const raw = encodeClaudeProjectPath(pathValue)
  const composed = encodeClaudeProjectPath(pathValue.normalize('NFC'))
  return raw === composed ? [raw] : [raw, composed]
}

/** Preserve case and one dash per non-alphanumeric character; Claude bucket names do not collapse runs. */
export function encodeClaudeProjectPath(pathValue: string): string {
  const separated = normalizeRuntimePathSeparators(pathValue)
  const trimmed =
    separated === '/' || /^[A-Za-z]:\/$/.test(separated) ? separated : separated.replace(/\/+$/, '')
  return trimmed.replace(/[^a-zA-Z0-9]/g, '-')
}

// Claude Code names a longer encoded path's bucket `<first 200 characters>-<hash>`; older versions kept the full name.
const CLAUDE_BUCKET_NAME_MAX_LENGTH = 200

/** Bucket-name prefixes for a scope, including the 200-character cut Claude Code makes for long paths. */
export function claudeProjectBucketScopePrefixes(pathValue: string): string[] {
  return encodeClaudeProjectPaths(pathValue).flatMap((encoded) =>
    encoded.length > CLAUDE_BUCKET_NAME_MAX_LENGTH
      ? [encoded, encoded.slice(0, CLAUDE_BUCKET_NAME_MAX_LENGTH)]
      : [encoded]
  )
}

/** Whether a bucket is a scope's own or one below it; see claudeProjectBucketNameBelowScope. */
export function isClaudeProjectBucketInScope(
  projectDirName: string,
  scopePrefixes: Iterable<string>
): boolean {
  for (const prefix of scopePrefixes) {
    if (claudeProjectBucketNameBelowScope(projectDirName, prefix) !== null) {
      return true
    }
  }
  return false
}

/** The encoded path below one scope prefix (`''` for the scope's own bucket), or null when the bucket is outside it.
 * An encoded separator boundary keeps orca from matching its sibling orcadyne; a root (`-`, `C--`) keeps its separator. */
export function claudeProjectBucketNameBelowScope(
  projectDirName: string,
  scopePrefix: string
): string | null {
  if (projectDirName === scopePrefix) {
    return ''
  }
  const isRoot = scopePrefix === '-' || /^[A-Za-z]--$/.test(scopePrefix)
  const head = isRoot ? scopePrefix : `${scopePrefix}-`
  return projectDirName.startsWith(head) ? projectDirName.slice(head.length) : null
}

/** A name this long may be a `<first 200>-<hash>` cut that no longer spells the path; legacy full names are this long too. */
export function mayBeHashedClaudeProjectBucketName(projectDirName: string): boolean {
  return projectDirName.length > CLAUDE_BUCKET_NAME_MAX_LENGTH
}

/** Transcripts sit in project buckets (depth 0); `<session id>/` folders below hold only subagent and tool output. */
export function isClaudeProjectBucketDirectory(_name: string, depth: number): boolean {
  return depth === 0
}
