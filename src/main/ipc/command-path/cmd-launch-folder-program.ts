import { win32 } from 'node:path'
import {
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../../shared/concurrency/abort-signal-reason'
import { isExecutableFile } from './command-path-directory'
import { resolveCommandOnLocalPath } from './command-path-resolver'

type CmdFolderCheck = {
  candidates: Map<string, boolean | Promise<boolean>>
  waiters: number
  pendingStats: number
}

const cmdFolderChecks = new Map<string, CmdFolderCheck>()

export async function resolveCmdLaunchFolderProgram(
  program: string,
  cwd: string,
  pathExt: string | undefined,
  signal: AbortSignal
): Promise<string | null> {
  throwIfSignalAborted(signal)
  const key = JSON.stringify([win32.resolve(cwd).toLowerCase(), program.toLowerCase(), pathExt])
  const check: CmdFolderCheck = cmdFolderChecks.get(key) ?? {
    candidates: new Map(),
    waiters: 0,
    pendingStats: 0
  }
  cmdFolderChecks.set(key, check)
  // An uncancellable stat can outlive its last caller and still serve a live retry.
  const discardIfIdle = () => {
    if (check.waiters === 0 && check.pendingStats === 0) {
      cmdFolderChecks.delete(key)
    }
  }
  check.waiters++
  try {
    const result = await resolveCommandOnLocalPath(program, {
      platform: 'win32',
      cwd,
      env: { PATH: '', PATHEXT: pathExt },
      signal,
      probeCandidate: (candidate) => {
        const candidateKey = win32.resolve(candidate).toLowerCase()
        let result = check.candidates.get(candidateKey)
        if (typeof result === 'boolean') {
          return Promise.resolve(result)
        }
        if (!result) {
          check.pendingStats++
          result = isExecutableFile(candidate, true).then((hit) => {
            check.candidates.set(candidateKey, hit)
            check.pendingStats--
            discardIfIdle()
            return hit
          })
          check.candidates.set(candidateKey, result)
        }
        return waitForPromiseWithSignal(result, signal)
      }
    })
    throwIfSignalAborted(signal)
    return result
  } finally {
    check.waiters--
    discardIfIdle()
  }
}
