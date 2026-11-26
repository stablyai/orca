import {
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../../shared/concurrency/abort-signal-reason'
import { isExecutableFile } from './command-path-directory'
import { resolveCommandOnLocalPath } from './command-path-resolver'

const pendingCmdFolderStats = new Map<string, Promise<boolean>>()

export async function resolveCmdLaunchFolderProgram(
  program: string,
  cwd: string,
  pathExt: string | undefined,
  signal: AbortSignal
): Promise<string | null> {
  throwIfSignalAborted(signal)
  const result = await resolveCommandOnLocalPath(program, {
    platform: 'win32',
    cwd,
    env: { PATH: '', PATHEXT: pathExt },
    signal,
    probeCandidate: (candidate) => {
      let pending = pendingCmdFolderStats.get(candidate)
      if (!pending) {
        // A stat can outlive its last caller, but a later launch must recheck once it settles.
        pending = isExecutableFile(candidate, true).finally(() => {
          pendingCmdFolderStats.delete(candidate)
        })
        pendingCmdFolderStats.set(candidate, pending)
      }
      return waitForPromiseWithSignal(pending, signal)
    }
  })
  throwIfSignalAborted(signal)
  return result
}
