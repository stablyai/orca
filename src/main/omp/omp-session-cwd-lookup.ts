import { createHash } from 'node:crypto'
import { lstat, opendir, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { PI_CWD_BUCKET_LAYOUT } from '../ai-vault/session-cwd-bucket-layouts'
import { SESSION_FILE_ID_LAYOUTS } from '../native-chat/session-file-id-layouts'

async function canonicalPath(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path))
}

function relativeBucket(root: string, cwd: string, prefix: string): string | null {
  const path = relative(root, cwd)
  if (path.startsWith('..') || isAbsolute(path)) {
    return null
  }
  const encoded = path.replace(/[/\\:]/g, '-')
  return encoded ? `${prefix}${prefix.endsWith('-') ? '' : '-'}${encoded}` : prefix
}

function launchTempDir(env: NodeJS.ProcessEnv): string {
  return process.platform === 'win32'
    ? env.TEMP || env.TMP || join(env.SystemRoot || env.windir || 'C:\\Windows', 'temp')
    : env.TMPDIR || env.TMP || env.TEMP || '/tmp'
}

/** OMP's current and migrated cwd buckets, derived without enumerating other workspaces. */
async function cwdBuckets(cwd: string, home: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const [canonicalCwd, canonicalHome, canonicalTemp] = await Promise.all([
    canonicalPath(cwd),
    canonicalPath(home),
    canonicalPath(launchTempDir(env))
  ])
  const homeBucket = relativeBucket(canonicalHome, canonicalCwd, '-')
  const tempBucket = relativeBucket(canonicalTemp, canonicalCwd, '-tmp')
  const legacy = [cwd, canonicalCwd].flatMap((path) =>
    PI_CWD_BUCKET_LAYOUT.encodeScopePrefixes(path).map((prefix) => `${prefix}--`)
  )
  const scope = tempBucket !== null ? 'tmp' : homeBucket !== null ? 'home' : 'abs'
  const readable = basename(canonicalCwd)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(-80)
  // OMP 17.2.5–17.2.8 used this name before restoring and migrating cwd buckets.
  const digest = createHash('sha256').update(canonicalCwd.replaceAll('\\', '/')).digest('hex')
  return [
    ...new Set([tempBucket, homeBucket, ...legacy, `${scope}-${readable || 'project'}-${digest}`])
  ].filter((name): name is string => name !== null)
}

/** Import only a known workspace's direct session files, stopping at its first ID match. */
export async function findOmpSessionByCwd(input: {
  sessionsDir: string
  sessionId: string
  cwd: string
  homeDir: string
  env: NodeJS.ProcessEnv
  strictErrors?: boolean
}): Promise<string | null> {
  const sessionId = input.sessionId.trim()
  if (!sessionId || !isAbsolute(input.cwd)) {
    return null
  }
  for (const bucket of await cwdBuckets(input.cwd, input.homeDir, input.env)) {
    const dirPath = join(input.sessionsDir, bucket)
    try {
      const stat = await lstat(dirPath)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        continue
      }
      const directory = await opendir(dirPath)
      for await (const entry of directory) {
        if (
          !entry.isFile() ||
          entry.isSymbolicLink() ||
          extname(entry.name).toLowerCase() !== '.jsonl'
        ) {
          continue
        }
        const file = join(dirPath, entry.name)
        if (SESSION_FILE_ID_LAYOUTS.omp.fileMatchesId(file, sessionId)) {
          return file
        }
      }
    } catch (error) {
      if (
        input.strictErrors &&
        !(
          error instanceof Error &&
          'code' in error &&
          (error.code === 'ENOENT' || error.code === 'ENOTDIR')
        )
      ) {
        throw error
      }
      // A stale or unreadable bucket must not replace a missing history with a blank chat.
    }
  }
  return null
}
