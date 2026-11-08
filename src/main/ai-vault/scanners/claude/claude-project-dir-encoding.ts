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

/** Require an encoded separator boundary so orca cannot match its sibling orcadyne. */
export function isClaudeProjectDirInScope(
  projectDirName: string,
  scopePrefixes: ReadonlySet<string> | readonly string[]
): boolean {
  for (const prefix of scopePrefixes) {
    if (projectDirName === prefix || projectDirName.startsWith(`${prefix}-`)) {
      return true
    }
  }
  return false
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

/** Like isClaudeProjectDirInScope, but a root (`-`, `C--`) keeps its separator, so it prefixes every bucket. */
export function isClaudeProjectBucketInScope(
  projectDirName: string,
  scopePrefixes: ReadonlySet<string>
): boolean {
  for (const prefix of scopePrefixes) {
    const isRoot = prefix === '-' || /^[A-Za-z]--$/.test(prefix)
    if (
      isRoot
        ? projectDirName.startsWith(prefix)
        : isClaudeProjectDirInScope(projectDirName, [prefix])
    ) {
      return true
    }
  }
  return false
}

/** Transcripts sit in project buckets (depth 0); `<session id>/` folders below hold only subagent and tool output. */
export function isClaudeProjectBucketDirectory(_name: string, depth: number): boolean {
  return depth === 0
}
