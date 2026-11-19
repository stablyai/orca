import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { encodeClaudeProjectPaths } from '../../ai-vault/scanners/claude/claude-project-dir-encoding'
import { isMissingTranscriptPathError } from '../../ai-vault/discovery/session-path-absence'
import { errnoCodeOrUnknown } from '../../../shared/errors/errno-code'

// Ids become path segments here; a separator or dot segment would escape the bucket.
function isSafeClaudeSessionId(sessionId: string): boolean {
  return (
    sessionId !== '.' &&
    sessionId !== '..' &&
    !sessionId.includes('/') &&
    !sessionId.includes('\\') &&
    !sessionId.includes('\0')
  )
}

// A bucket this user can't read can't hold a transcript their Claude can resume (e.g. one left by `sudo claude`).
function isAbsentForUserError(error: unknown): boolean {
  return isMissingTranscriptPathError(error) || errnoCodeOrUnknown(error) === 'EACCES'
}

type ProbeOptions = { signal?: AbortSignal; strictErrors?: boolean }

// lstat, like the discovery walk's Dirent checks: symlinked buckets and files can point outside this account.
async function isEntry(
  path: string,
  kind: 'file' | 'directory',
  options: ProbeOptions
): Promise<boolean> {
  options.signal?.throwIfAborted()
  try {
    const info = await lstat(path)
    options.signal?.throwIfAborted()
    return kind === 'file' ? info.isFile() : info.isDirectory()
  } catch (error) {
    options.signal?.throwIfAborted()
    if (options.strictErrors && !isAbsentForUserError(error)) {
      throw error
    }
    return false
  }
}

/**
 * Claude writes `<projects>/<encoded cwd>/<id>.jsonl` and nothing deeper is a session transcript,
 * so probe the cwd bucket, then each bucket once, and stop at the first file.
 */
export async function findClaudeSessionFile(
  projectsDir: string,
  sessionId: string,
  options: ProbeOptions & { cwd?: string }
): Promise<string | null> {
  if (!isSafeClaudeSessionId(sessionId)) {
    return null
  }
  const fileName = `${sessionId}.jsonl`
  // Encode the cwd as given, like Claude does; a hint that can't name a bucket (too long) only falls back.
  const preferred = options.cwd?.trim() ? encodeClaudeProjectPaths(options.cwd) : []
  const hintOptions = { signal: options.signal }
  for (const bucket of preferred) {
    const bucketDir = join(projectsDir, bucket)
    if (
      (await isEntry(bucketDir, 'directory', hintOptions)) &&
      (await isEntry(join(bucketDir, fileName), 'file', hintOptions))
    ) {
      return join(bucketDir, fileName)
    }
  }

  options.signal?.throwIfAborted()
  let buckets
  try {
    buckets = await readdir(projectsDir, { withFileTypes: true })
  } catch (error) {
    options.signal?.throwIfAborted()
    if (options.strictErrors && !isMissingTranscriptPathError(error)) {
      throw error
    }
    return null
  }
  for (const bucket of buckets) {
    // Hinted buckets are probed again so their real I/O errors still surface under strictErrors.
    if (!bucket.isDirectory()) {
      continue
    }
    const candidate = join(projectsDir, bucket.name, fileName)
    if (await isEntry(candidate, 'file', options)) {
      return candidate
    }
  }
  // A listing with no project folders probes nothing, so check cancellation before reporting a miss.
  options.signal?.throwIfAborted()
  return null
}
