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

/** A folder's `oauthAccount`, undefined without one or without a `.claude.json`. Throws when unparsable. */
export async function oauthAccountForBackup(folder: RotationFolder): Promise<unknown> {
  let text: string
  try {
    text = await readFile(folder.stateFile, 'utf8')
  } catch (error) {
    // Any other read error could hide an `oauthAccount` the backup must keep.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }
    throw error
  }
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) {
    throw new Error('bad_shape')
  }
  return value.oauthAccount
}

/**
 * Sets each folder's `oauthAccount` (undefined removes it) so the account details follow the
 * login. Setting values, instead of trading them, makes a repeat after an interruption harmless.
 */
export async function setLoginMeta(
  a: RotationFolder,
  b: RotationFolder,
  accountA: unknown,
  accountB: unknown
): Promise<string> {
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
    for (const [state, account] of [
      [stateA, accountA],
      [stateB, accountB]
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
