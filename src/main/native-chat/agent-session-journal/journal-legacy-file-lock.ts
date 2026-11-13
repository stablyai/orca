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

/** The helper never opens SQLite; closing stdin releases its single non-writing source handle. */
export async function acquireJournalLegacyFileLock(filename: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const child = spawnProcess({
    program: journalLegacyFileLockPath(),
    args: [filename],
    stdio: 'pipe'
  })
  child.stdin.on('error', () => {})
  child.stderr.resume()
  let exited = false
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => {
      exited = true
      if (code === 0) {
        resolve()
      } else {
        reject(new Error('legacy journal lock is unavailable'))
      }
    })
  })
  void done.catch(() => {})
  const release = () => child.stdin.end()
  signal.addEventListener('abort', release, { once: true })
  if (signal.aborted) {
    release()
  }
  try {
    await new Promise<void>((resolve, reject) => {
      let output = ''
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString()
        if (output === 'locked\n' || output === 'locked\r\n') {
          resolve()
        } else if (output.length > 64) {
          reject(new Error('invalid legacy lock acknowledgement'))
        }
      })
      child.once('error', reject)
      child.once('exit', () => reject(new Error('legacy journal lock was refused')))
    })
  } catch (error) {
    release()
    await done.catch(() => {})
    signal.removeEventListener('abort', release)
    throw error
  }
  return {
    held: () => !exited && !signal.aborted,
    close: async () => {
      release()
      try {
        await done
      } finally {
        signal.removeEventListener('abort', release)
      }
    }
  }
}
