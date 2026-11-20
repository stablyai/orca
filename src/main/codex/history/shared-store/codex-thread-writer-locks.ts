import { constants } from 'node:fs'
import { access, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawnProcess } from '@orca/process-host'
import { windowsPowerShellPath } from '@orca/process-host/windows-system-binary'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { DirectoryLinkError, lstatIfPresent } from '../../../filesystem/merged-directory-link'
import {
  COORDINATION_LOCK,
  PERL_PROBE,
  POWERSHELL_PROBE,
  SH_PROBE,
  THREAD_LOCK_NAME
} from './codex-thread-lock-probe-scripts'

export const WRITER_LOCKS = 'thread-writer-locks'
const PROBE_TIMEOUT_MS = 10_000

// `unavailable`: no helper program could start (no perl, no flock(1), no PowerShell).
type ProbeAnswer = 'held' | 'idle' | 'unknown' | 'unavailable'
type LockHold =
  | { answer: ProbeAnswer }
  | {
      answer: 'ready'
      stillHeld: () => boolean
      releaseFirst: () => Promise<boolean>
      release: () => Promise<void>
    }

// `no-flock`: the sh helper found no flock(1) to run.
const HELPER_ANSWERS = new Set(['held', 'idle', 'unknown', 'ready', 'released', 'no-flock'])

async function perlProgram(): Promise<string> {
  // Not every distro ships /usr/bin/perl (NixOS keeps it elsewhere); the spawn then searches PATH.
  return (await access('/usr/bin/perl', constants.X_OK).then(
    () => true,
    () => false
  ))
    ? '/usr/bin/perl'
    : 'perl'
}

type ProbeSpec = { program: string; args: string[]; env?: NodeJS.ProcessEnv }

// null when a helper started but gave no usable answer (a timeout, a crash, a spawn error that
// may pass); `unavailable` only when no helper program exists here.
async function startProbe(dirs: string[], hold: boolean): Promise<LockHold | null> {
  if (process.platform === 'win32') {
    return runProbe(
      {
        program: windowsPowerShellPath(),
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', POWERSHELL_PROBE],
        env: {
          ...process.env,
          ORCA_CODEX_THREAD_LOCKS: dirs.join('|'),
          ORCA_CODEX_HOLD: hold ? '1' : '0'
        }
      },
      hold
    )
  }
  const args = [hold ? 'hold' : 'sweep', ...dirs]
  const perl = await runProbe(
    { program: await perlProgram(), args: ['-e', PERL_PROBE, '--', ...args] },
    hold
  )
  return perl?.answer === 'unavailable'
    ? runProbe({ program: '/bin/sh', args: ['-c', SH_PROBE, 'sh', ...args] }, hold)
    : perl
}

// A missing or unrunnable program; any other spawn error (EAGAIN, EMFILE) may pass, so stays busy.
function isMissingProgram(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'EACCES'
}

async function runProbe(spec: ProbeSpec, hold: boolean): Promise<LockHold | null> {
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawnProcess({ ...spec, stdio: 'pipe' })
  } catch (error) {
    return isMissingProgram(error) ? { answer: 'unavailable' } : null
  }
  let failedToStart = false
  const closed = new Promise<null>((resolve) => {
    child.once('close', () => resolve(null))
    child.once('error', (error) => {
      failedToStart = child.pid === undefined && isMissingProgram(error)
      resolve(null)
    })
  })
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream.on('error', () => {})
  }
  child.stderr.resume()
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  // Skips anything a shell profile or warning printed before the helper's own answer.
  const nextLine = async (): Promise<string | null> => {
    for (;;) {
      const line = await Promise.race([lines.next(), closed])
      if (!line || line.done) {
        return null
      }
      const text = String(line.value).trim()
      if (HELPER_ANSWERS.has(text)) {
        return text
      }
    }
  }
  const stop = async (): Promise<void> => {
    child.stdin.end()
    // One that won't exit is killed, so a later pass never waits on it.
    const kill = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS)
    kill.unref?.()
    await closed
    clearTimeout(kill)
  }
  // Killing the helper releases all it holds, so one that never answers can't keep Codex waiting.
  // Never once it's ready: a move in progress must not lose its hold.
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, PROBE_TIMEOUT_MS)
  timer.unref?.()
  const answer = await nextLine()
  clearTimeout(timer)
  // A `ready` read after the kill (still buffered) holds nothing anymore.
  const stillHeld = (): boolean =>
    !timedOut && !child.killed && child.exitCode === null && child.signalCode === null
  if (answer === 'ready' && hold && stillHeld()) {
    return {
      answer,
      stillHeld,
      releaseFirst: async () => {
        child.stdin.write('first\n')
        // Before any move starts, so killing one that never acknowledges loses nothing.
        const ack = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS)
        ack.unref?.()
        const released = (await nextLine()) === 'released' && stillHeld()
        clearTimeout(ack)
        return released
      },
      release: stop
    }
  }
  await stop()
  if ((answer === null && failedToStart) || answer === 'no-flock') {
    return { answer: 'unavailable' }
  }
  if (answer === 'ready' || timedOut) {
    return null
  }
  return answer === 'held' || answer === 'idle' || answer === 'unknown' ? { answer } : null
}

/**
 * Sweeps a thread-writer-locks folder as Codex does and says whether a Codex may be writing there:
 * a lock counts only while some process holds it (any user, PID namespace or Windows session), and
 * coordination already taken (a writer starting, a publication) counts too. Free locks are deleted,
 * so one a Codex takes later has no stale twin elsewhere. Without the helper nothing is deleted
 * and any lock file left in the folder counts, as before.
 */
async function sweepCodexThreadLocks(locksDir: string): Promise<boolean> {
  const probe = await startProbe([locksDir], false)
  return probe && probe.answer !== 'unavailable'
    ? probe.answer !== 'idle'
    : keepsThreadLock(locksDir)
}

// `no-helper`: busy because no helper can run here to hold coordination.
export type LockFolderBusy = 'busy' | 'no-helper'

/**
 * Moves the account's lock folder into the store's (`move`) with both folders' coordination held
 * exclusively, after sweeping both: no Codex can take or release a thread lock in either meanwhile,
 * so no thread ends up guarded by two files (a release deletes its lock by path, which the link
 * would point at the other writer's file). `held`: a Codex holds a thread lock in the account; the
 * store's own held locks don't count. `busy`: coordination was taken, or a thread is locked in both.
 * `no-helper`: no helper can run here, and moving unheld could link around a lock taken meanwhile.
 */
export async function moveIdleThreadLockFolder(
  accountHome: string,
  storeHome: string,
  move: () => Promise<unknown>
): Promise<'moved' | 'held' | LockFolderBusy> {
  const accountLocks = join(accountHome, WRITER_LOCKS)
  // A coordination file a Codex created mid-move would go unheld.
  await mkdir(accountLocks, { recursive: true })
  const hold = await startProbe([accountLocks, join(storeHome, WRITER_LOCKS)], true)
  if (hold?.answer === 'held') {
    return 'held'
  }
  if (hold?.answer === 'unavailable') {
    return 'no-helper'
  }
  // Without both coordination locks the move could link around a lock taken meanwhile.
  if (!hold || !('release' in hold)) {
    return 'busy'
  }
  try {
    if (await hasThreadLockConflict(accountHome, storeHome)) {
      return 'busy'
    }
    // Windows never renames a folder with a file open inside, the held coordination file
    // included. Once it's let go, a Codex opening any file there fails the rename instead.
    if (process.platform === 'win32' ? !(await hold.releaseFirst()) : !hold.stillHeld()) {
      return 'busy'
    }
    try {
      await move()
    } catch (error) {
      if (isStartingCodexError(error)) {
        return 'busy'
      }
      throw error
    }
    return 'moved'
  } finally {
    await hold.release()
  }
}

// A Codex that started meanwhile: a file it opened (Windows) or the folder it recreated mid-swap.
function isStartingCodexError(error: unknown): boolean {
  if (error instanceof DirectoryLinkError) {
    return error.code === 'link-failed'
  }
  const code = (error as NodeJS.ErrnoException | null)?.code
  return process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')
}

// A thread lock only guards a writer while some process holds it: Codex leaves the file behind
// after a crash, and whenever releasing it finds coordination contended, so its mere presence
// proves nothing. A folder that's missing, or a link (its target is swept on its own), has none.
export async function holdsThreadLock(locks: string): Promise<boolean> {
  const folder = await lstatIfPresent(locks)
  if (!folder || folder.isSymbolicLink()) {
    return false
  }
  return sweepCodexThreadLocks(locks)
}

/** Any thread lock file at all, held or not (an unreadable folder may hold one). */
export async function keepsThreadLock(locks: string): Promise<boolean> {
  const names = await readdir(locks).catch((error: unknown) =>
    isDefinitiveAbsence(error) ? [] : null
  )
  return names === null || names.some((name) => THREAD_LOCK_NAME.test(name))
}

// A thread lock in both folders as different files can't merge: the account's may have been taken
// since the sweep, and dropping either name would let a second writer lock the other.
async function hasThreadLockConflict(accountHome: string, storeHome: string): Promise<boolean> {
  for (const name of await readdir(join(accountHome, WRITER_LOCKS)).catch(() => [])) {
    if (name === COORDINATION_LOCK) {
      continue
    }
    const [mine, theirs] = await Promise.all([
      lstatIfPresent(join(accountHome, WRITER_LOCKS, name)),
      lstatIfPresent(join(storeHome, WRITER_LOCKS, name))
    ])
    if (mine && theirs && (mine.dev !== theirs.dev || mine.ino !== theirs.ino)) {
      return true
    }
  }
  return false
}
