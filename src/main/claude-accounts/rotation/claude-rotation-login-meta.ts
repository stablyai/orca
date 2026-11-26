import { readFile, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { durableWriteTempPath, writeFileDurable } from '../../filesystem/durable-file-write'
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

async function readObject(path: string): Promise<Record<string, unknown> | null> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  return isRecord(value) ? value : null
}

async function fileMode(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mode & 0o777
  } catch {
    return null
  }
}

function writeState(path: string, state: Record<string, unknown>, mode: number): Promise<void> {
  return writeFileDurable(durableWriteTempPath(path), path, JSON.stringify(state, null, 2), mode)
}

export async function readOauthAccount(folder: RotationFolder): Promise<Record<string, unknown>> {
  try {
    const account = (await readObject(folder.stateFile))?.oauthAccount
    return isRecord(account) ? account : {}
  } catch {
    return {}
  }
}

/** Swaps `oauthAccount` so each folder's account details follow its login. */
export async function swapLoginMeta(a: RotationFolder, b: RotationFolder): Promise<string> {
  const modeA = await fileMode(a.stateFile)
  const modeB = await fileMode(b.stateFile)
  if (modeA === null || modeB === null) {
    return 'skipped_no_file'
  }
  const lock = new RotationDirLock([
    await claudeFileLockPath(a.stateFile),
    await claudeFileLockPath(b.stateFile)
  ])
  if (!(await lock.acquire(ROTATION_TIMING.metaLockWaitMs))) {
    return 'busy'
  }
  try {
    const stateA = await readObject(a.stateFile)
    const stateB = await readObject(b.stateFile)
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
    await writeState(a.stateFile, stateA, modeA)
    await writeState(b.stateFile, stateB, modeB)
    return 'ok'
  } catch (error) {
    return `error_${error instanceof Error ? error.name : 'unknown'}`
  } finally {
    await lock.release()
  }
}

/** Claude re-reads its stored login when `.credentials.json` changes; never create the file. */
export async function nudgeRunningSessions(...folders: RotationFolder[]): Promise<void> {
  const now = new Date()
  for (const folder of folders) {
    try {
      // utimes never creates a missing file.
      await utimes(join(folder.home, '.credentials.json'), now, now)
    } catch {
      // Sessions still pick the new login up on their next read.
    }
  }
}
