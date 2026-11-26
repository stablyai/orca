import { win32 } from 'node:path'
import {
  abortSignalReason,
  throwIfSignalAborted
} from '../../../shared/concurrency/abort-signal-reason'
import { PromiseSettlementWaiters } from '../../../shared/concurrency/promise-settlement-waiters'
import { resolveCommandOnLocalPath } from './command-path-resolver'

const cmdFolderLookups = new Map<
  string,
  { controller: AbortController; waiters: PromiseSettlementWaiters<string | null> }
>()

export function resolveCmdLaunchFolderProgram(
  program: string,
  cwd: string,
  pathExt: string | undefined,
  signal: AbortSignal
): Promise<string | null> {
  throwIfSignalAborted(signal)
  const key = JSON.stringify([win32.resolve(cwd).toLowerCase(), program.toLowerCase(), pathExt])
  let pending = cmdFolderLookups.get(key)
  if (!pending) {
    const controller = new AbortController()
    const waiters = new PromiseSettlementWaiters(
      resolveCommandOnLocalPath(program, {
        platform: 'win32',
        cwd,
        env: { PATH: '', PATHEXT: pathExt },
        signal: controller.signal
      }),
      () => {
        if (cmdFolderLookups.get(key)?.waiters === waiters) {
          cmdFolderLookups.delete(key)
        }
      }
    )
    pending = { controller, waiters }
    cmdFolderLookups.set(key, pending)
  }
  const { controller, waiters } = pending
  return waiters.wait({
    signal,
    createAbortError: () => abortSignalReason(signal),
    onAbandon: () => {
      if (waiters.waiterCount === 0) {
        // The outstanding stat is uncancellable; retain its key until it settles.
        controller.abort()
      }
    }
  })
}
