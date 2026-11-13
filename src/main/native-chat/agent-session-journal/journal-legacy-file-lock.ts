import { signalProcessTree } from '@orca/process-host/process-tree-termination'
import { JournalLegacyRetentionError } from './journal-legacy-retention-error'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { currentWorkerEntryLayout } from '../../worker-threads/worker-thread-entry-path'

export function journalLegacyFileLockPath(): string {
  const name = process.platform === 'win32' ? 'journal-file-lock.exe' : 'journal-file-lock'
  const layout = currentWorkerEntryLayout(__dirname)
  if (layout.isPackaged && layout.resourcesPath) {
    return join(layout.resourcesPath, 'bin', name)
  }
  const require = createRequire(__filename)
  const staged = join(dirname(require.resolve('node-pty/package.json')), 'build', 'Release', name)
  return existsSync(staged) ? staged : resolve('native/journal-file-lock/.build', name)
}

/** Both helper modes are bounded; only observed exit releases the source gate. */
async function startLegacyHelper(
  filename: string,
  signal: AbortSignal,
  check: boolean,
  spawn: PipedProcessSpawner = spawnProcess
) {
  signal.throwIfAborted()
  const child = spawn({
    program: journalLegacyFileLockPath(),
    args: [filename, ...(check ? ['--check'] : [])],
    stdio: 'pipe',
    detached: process.platform !== 'win32'
  })
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
        reject(error)
      }
    })
    child.once('exit', (code) => {
      exited = true
      clearTimeout(forceTimer)
      if (code === 0) {
        resolve()
      } else {
        const error =
          code === 4
            ? new JournalLegacyRetentionError('legacy storage or file identity is unsupported')
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
  const close = () =>
    (closing ??= (async () => {
      child.stdin.end()
      forceTimer = setTimeout(force, 250)
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
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
    if (
      output === (check ? 'eligible\n' : 'locked\n') ||
      output === (check ? 'eligible\r\n' : 'locked\r\n')
    ) {
      ready.resolve()
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
    await close().catch(() => {})
    throw error
  } finally {
    clearTimeout(startup)
  }
  return { held: () => !exited && !signal.aborted, close }
}

export function acquireJournalLegacyFileLock(
  filename: string,
  signal: AbortSignal,
  spawn?: PipedProcessSpawner
) {
  return startLegacyHelper(filename, signal, false, spawn)
}

export async function checkJournalLegacyFileLock(
  filename: string,
  signal: AbortSignal
): Promise<void> {
  if (!existsSync(journalLegacyFileLockPath())) {
    throw new JournalLegacyRetentionError('legacy journal lock asset is unavailable')
  }
  await startLegacyHelper(filename, signal, true)
}

export function requireJournalLegacyFileLock(): void {
  if (!existsSync(journalLegacyFileLockPath())) {
    throw new JournalLegacyRetentionError('legacy journal lock asset is unavailable')
  }
}
