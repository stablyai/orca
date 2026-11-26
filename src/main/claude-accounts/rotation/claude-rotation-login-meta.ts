import { existsSync, readFileSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomically } from '../../filesystem/atomic-file-publication'
import { isRecord } from './claude-rotation-keychain'
import { claudeFileLockPath, RotationDirLock } from './claude-rotation-locks'
import { ROTATION_TIMING } from './claude-rotation-policy'

export type RotationFolder = {
  accountId: string
  home: string
  service: string
  /** The folder's `.claude.json`, which names the signed-in account. */
  stateFile: string
}

function readObject(path: string): Record<string, unknown> | null {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  return isRecord(value) ? value : null
}

export function readOauthAccount(folder: RotationFolder): Record<string, unknown> {
  try {
    const account = readObject(folder.stateFile)?.oauthAccount
    return isRecord(account) ? account : {}
  } catch {
    return {}
  }
}

/** Swaps `oauthAccount` so each folder's account details follow its login. */
export async function swapLoginMeta(a: RotationFolder, b: RotationFolder): Promise<string> {
  if (!existsSync(a.stateFile) || !existsSync(b.stateFile)) {
    return 'skipped_no_file'
  }
  const lock = new RotationDirLock([
    claudeFileLockPath(a.stateFile),
    claudeFileLockPath(b.stateFile)
  ])
  if (!(await lock.acquire(ROTATION_TIMING.metaLockWaitMs))) {
    return 'busy'
  }
  try {
    const stateA = readObject(a.stateFile)
    const stateB = readObject(b.stateFile)
    if (!stateA || !stateB) {
      return 'bad_shape'
    }
    const accountA = stateA.oauthAccount
    const accountB = stateB.oauthAccount
    for (const [state, account] of [
      [stateA, accountB],
      [stateB, accountA]
    ] as const) {
      if (account === undefined) {
        delete state.oauthAccount
      } else {
        state.oauthAccount = account
      }
    }
    const modeA = statSync(a.stateFile).mode & 0o777
    const modeB = statSync(b.stateFile).mode & 0o777
    writeFileAtomically(a.stateFile, JSON.stringify(stateA, null, 2), { mode: modeA })
    writeFileAtomically(b.stateFile, JSON.stringify(stateB, null, 2), { mode: modeB })
    return 'ok'
  } catch (error) {
    return `error_${error instanceof Error ? error.name : 'unknown'}`
  } finally {
    lock.release()
  }
}

/** Claude re-reads its stored login when `.credentials.json` changes; never create the file. */
export function nudgeRunningSessions(...folders: RotationFolder[]): void {
  for (const folder of folders) {
    const path = join(folder.home, '.credentials.json')
    try {
      if (existsSync(path)) {
        const now = new Date()
        utimesSync(path, now, now)
      }
    } catch {
      // Sessions still pick the new login up on their next read.
    }
  }
}
