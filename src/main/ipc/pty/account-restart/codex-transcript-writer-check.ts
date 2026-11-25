import { execFile } from 'node:child_process'
import { readdir, readlink, realpath } from 'node:fs/promises'
import { join } from 'node:path'

type ExecResult = { code: number | null; stdout: string; stderr: string }
type Exec = (file: string, args: readonly string[]) => Promise<ExecResult>

export type TranscriptWriterCheckDeps = {
  platform: NodeJS.Platform
  exec: Exec
  /** Every path some process has open (Linux /proc); null when it cannot be read. */
  openPaths: () => Promise<Set<string> | null>
  realpath: (path: string) => Promise<string>
}

// Why a bound: the check runs once per restart, after the user clicked; a stuck lsof must not hold it.
const LSOF_TIMEOUT_MS = 5000

/**
 * Whether no process still holds the stopped conversation's transcript open. Codex's rollout
 * recorder keeps that file open for the whole session, so an open handle after the stop is a writer
 * that the stop's descendant proof did not cover. Only a positive answer is proof: an unreadable or
 * failed check counts as a live writer, and the resume stays on the old account.
 */
export async function transcriptHasNoOpenWriter(
  transcriptPath: string,
  deps: TranscriptWriterCheckDeps = defaultDeps
): Promise<boolean> {
  try {
    if (deps.platform === 'win32') {
      // Windows has no cheap open-handle query; the owned job tree ending (writersExited) is the proof.
      return true
    }
    if (deps.platform === 'darwin') {
      // lsof matches by inode, so a linked sessions folder still names the same file. Exit 1 with no
      // output and no error is "no process has it open"; anything else is not proof.
      const result = await deps.exec('lsof', ['-t', '--', transcriptPath])
      return result.code === 1 && result.stdout.trim() === '' && result.stderr.trim() === ''
    }
    const target = await deps.realpath(transcriptPath)
    const open = await deps.openPaths()
    return open !== null && !open.has(target)
  } catch {
    return false
  }
}

const defaultDeps: TranscriptWriterCheckDeps = {
  platform: process.platform,
  exec: (file, args) =>
    new Promise((resolve) => {
      execFile(file, [...args], { timeout: LSOF_TIMEOUT_MS }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      })
    }),
  openPaths: readProcOpenPaths,
  realpath: (path) => realpath(path)
}

async function readProcOpenPaths(): Promise<Set<string> | null> {
  let pids: string[]
  try {
    pids = (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry))
  } catch {
    return null
  }
  const open = new Set<string>()
  for (const pid of pids) {
    let fds: string[]
    try {
      fds = await readdir(join('/proc', pid, 'fd'))
    } catch {
      // Another user's process or one that just exited; this user's writer is always readable.
      continue
    }
    for (const fd of fds) {
      try {
        open.add(await readlink(join('/proc', pid, 'fd', fd)))
      } catch {
        // The descriptor closed while listing.
      }
    }
  }
  return open
}
