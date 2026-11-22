import { signalProcessTree } from '@orca/process-host/process-tree-termination'
import {
  JournalLegacyRetentionError,
  JournalLegacyIneligibleError
} from './journal-legacy-retention-error'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'
import { createRequire } from 'node:module'
import { access, constants } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { currentWorkerEntryLayout } from '../../worker-threads/worker-thread-entry-path'

export async function journalLegacyFileLockPath(): Promise<string> {
  const name = process.platform === 'win32' ? 'journal-file-lock.exe' : 'journal-file-lock'
  const layout = currentWorkerEntryLayout(__dirname)
  if (layout.isPackaged && layout.resourcesPath) {
    return join(layout.resourcesPath, 'bin', name)
  }
  const require = createRequire(__filename)
  const staged = join(dirname(require.resolve('node-pty/package.json')), 'build', 'Release', name)
  try {
    await access(staged)
    return staged
  } catch {
    return resolve('native/journal-file-lock/.build', name)
  }
}

const RETIRE_GRACE_MS = 60_000

/** Lock mode waits for exit before source access; metadata failures can settle immediately. */
async function startLegacyHelper(
  filename: string,
  signal: AbortSignal,
  check: boolean,
  spawn: PipedProcessSpawner = spawnProcess,
  track?: (exited: Promise<void>) => void
) {
  signal.throwIfAborted()
  const terminated = Promise.withResolvers<void>()
  track?.(terminated.promise)
  let child: ReturnType<PipedProcessSpawner>
  try {
    const program = await journalLegacyFileLockPath()
    signal.throwIfAborted()
    child = spawn({
      program,
      args: [filename, ...(check ? ['--check'] : [])],
      stdio: 'pipe',
      detached: process.platform !== 'win32'
    })
  } catch (error) {
    terminated.resolve()
    throw error
  }
  child.stdin.on('error', () => {})
  child.stdout.on('error', () => {})
  child.stderr.on('error', () => {})
  child.stderr.resume()
  let exited = false
  let closing: Promise<void> | undefined
  let forceTimer: ReturnType<typeof setTimeout> | undefined
  const ready = Promise.withResolvers<void>()
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', (error) => {
      ready.reject(error)
      if (!child.pid) {
        exited = true
        terminated.resolve()
        reject(error)
      }
    })
    // 'close' comes after stdout drained, so "locked"/"retired" output is never lost to exit.
    child.once('close', (code) => {
      exited = true
      terminated.resolve()
      clearTimeout(forceTimer)
      if (code === 0) {
        resolve()
      } else {
        const error =
          code === 4
            ? new JournalLegacyIneligibleError('legacy storage or file identity is unsupported')
            : code === 7
              ? new JournalLegacyRetentionError('legacy companions still hold data')
              : new Error('legacy journal lock is unavailable')
        ready.reject(error)
        reject(error)
      }
      if (!check) {
        ready.reject(new Error('legacy journal lock was released'))
      }
    })
  })
  void done.catch(() => {})
  const force = () => {
    if (!exited) {
      void signalProcessTree(child, 'SIGKILL')
        .then((signalled) => {
          if (!signalled && !exited) {
            child.kill('SIGKILL')
          }
        })
        .catch(() => {
          if (!exited) {
            child.kill('SIGKILL')
          }
        })
    }
  }
  const close = (graceMs = 250) =>
    (closing ??= (async () => {
      child.stdin.end()
      forceTimer = setTimeout(force, graceMs)
      try {
        await done
      } finally {
        clearTimeout(forceTimer)
        signal.removeEventListener('abort', abort)
      }
    })())
  const abort = () => {
    ready.reject(signal.reason ?? new Error('legacy journal lock cancelled'))
    force()
    void close().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) {
    abort()
  }
  let output = ''
  let retired = false
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
    const lines = output.replace(/\r\n/g, '\n')
    if (lines === (check ? 'eligible\n' : 'locked\n')) {
      ready.resolve()
    } else if (lines === 'locked\nretired\n') {
      retired = true
    } else if (output.length > 64) {
      ready.reject(new Error('invalid legacy lock acknowledgement'))
    }
  })
  const startup = setTimeout(() => {
    ready.reject(new Error('legacy journal lock acknowledgement timed out'))
    force()
  }, 5000)
  try {
    await ready.promise
    if (check) {
      await close()
    }
  } catch (error) {
    force()
    const closed = close().catch(() => {})
    if (!check) {
      await closed
    }
    throw error
  } finally {
    clearTimeout(startup)
  }
  /**
   * The helper removes the journal itself while holding the lock, with a WAL of exactly the size
   * whose frames were absorbed; true only once it reported so.
   */
  const retire = async (walBytes: string): Promise<boolean> => {
    if (check || exited || signal.aborted || !/^\d+$/.test(walBytes)) {
      return false
    }
    child.stdin.write(`retire ${walBytes}\n`)
    // Unlinking a large file can take seconds; a helper stopped mid-way leaves only companions.
    await close(RETIRE_GRACE_MS)
    return retired
  }
  return { held: () => !exited && !signal.aborted, close: () => close(), retire }
}

export function acquireJournalLegacyFileLock(
  filename: string,
  signal: AbortSignal,
  spawn?: PipedProcessSpawner
) {
  return startLegacyHelper(filename, signal, false, spawn)
}

export function createJournalLegacyFileEligibility(): {
  present: () => void | Promise<void>
  check: (filename: string, signal: AbortSignal) => Promise<void>
} {
  let pending: Promise<void> | undefined
  return {
    present: requireJournalLegacyFileLock,
    async check(filename: string, signal: AbortSignal): Promise<void> {
      if (pending) {
        throw new Error('legacy journal eligibility pending')
      }
      await startLegacyHelper(filename, signal, true, spawnProcess, (exited) => {
        pending = exited
        const clear = () => {
          pending = undefined
        }
        void exited.then(clear, clear)
      })
    }
  }
}

async function requireJournalLegacyFileLock(): Promise<void> {
  try {
    // An install that dropped the executable bit (SFTP uploads do) can't run the helper.
    await access(
      await journalLegacyFileLockPath(),
      process.platform === 'win32' ? constants.F_OK : constants.X_OK
    )
  } catch {
    throw new JournalLegacyRetentionError('legacy journal lock asset is unavailable')
  }
}
