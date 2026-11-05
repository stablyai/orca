import type { IPty } from 'node-pty'
import type { TerminalCreationWork } from '../../daemon/terminal-host/terminal-creation-work'
import type { PtyCreationDisposition } from '../../../shared/terminal/pty/lifecycle/pty-creation-disposition'

/** Observe the returned handle before publication/cancellation can dispose its ordinary listener. */
export function trackLocalPtyCreation(work: TerminalCreationWork, spawn: () => IPty): IPty {
  const disposition = Promise.withResolvers<PtyCreationDisposition>()
  work.join(disposition.promise)
  let proc: IPty
  try {
    proc = spawn()
  } catch (error) {
    disposition.resolve({ kind: 'failed', completion: Promise.resolve() })
    throw error
  }
  const completion = Promise.withResolvers<void>()
  let code: number | null = null
  try {
    let listener: ReturnType<IPty['onExit']> | undefined
    listener = proc.onExit(({ exitCode }) => {
      code = exitCode
      completion.resolve()
      listener?.dispose()
    })
    if (code !== null) {
      listener?.dispose()
    }
    disposition.resolve({
      kind: 'physical',
      completion: completion.promise,
      exitCode: () => code,
      recover: async () => {
        if (code === null) {
          proc.kill('SIGKILL')
        }
        await completion.promise
      }
    })
  } catch (error) {
    disposition.resolve({
      kind: 'unknown',
      recover: async () => {
        proc.kill('SIGKILL')
      }
    })
    throw error
  }
  return proc
}
