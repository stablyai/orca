// Spots the Google app key landing in a folder (Downloads), for a key downloaded in the person's own
// browser. Browsers write under a temporary name and rename when done, so the final
// client_secret_*.json name appearing means the file is whole.
import { watch } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { GOOGLE_CLIENT_FILE_MAX_BYTES } from '../../shared/google/google-client-config'
import type {
  GoogleSetupFileResult,
  GoogleSetupFoundKey
} from '../../shared/google/google-setup-ipc-types'
import { parseGoogleClientFile } from './google-client-file'
import { watchedDirectoryDeletionCheck } from '../../shared/file-watch/windows-deleted-directory-watch'

// Google names the key client_secret_<id>.json; a repeat download adds " (1)" before .json.
export const GOOGLE_KEY_FILE_NAME = /^client_secret_.+\.json$/
// A file older than the watch is a key from an earlier setup, not this one.
const CLOCK_SLACK_MS = 2_000
const UNWATCHABLE = "Orca can't watch your Downloads folder. Add the file instead."

/** Resolves with the first new key file's text, or why not; `signal` stops the watch. */
export function watchFolderForGoogleKey(
  folder: string,
  signal: AbortSignal
): Promise<GoogleSetupFileResult> {
  const since = Date.now() - CLOCK_SLACK_MS
  return new Promise((resolve) => {
    let settled = false
    let watcher: ReturnType<typeof watch> | null = null
    const settle = (result: GoogleSetupFileResult): void => {
      if (!settled) {
        settled = true
        watcher?.close()
        resolve(result)
      }
    }
    const check = async (name: string): Promise<void> => {
      if (!GOOGLE_KEY_FILE_NAME.test(name)) {
        return
      }
      const file = join(folder, name)
      const info = await stat(file).catch(() => null)
      if (!info?.isFile() || info.mtimeMs < since || settled) {
        return
      }
      settle(
        info.size > GOOGLE_CLIENT_FILE_MAX_BYTES
          ? { ok: false, message: "This file is too large to be your team's Google app file." }
          : { ok: true, text: await readFile(file, 'utf8') }
      )
    }
    if (signal.aborted) {
      settle({ ok: false, message: 'Stopped watching Downloads.' })
      return
    }
    signal.addEventListener(
      'abort',
      () => settle({ ok: false, message: 'Stopped watching Downloads.' }),
      {
        once: true
      }
    )
    const settleUnwatchable = (): void =>
      settle({ ok: false, message: UNWATCHABLE, unwatchable: true })
    const isFolderDeleted = watchedDirectoryDeletionCheck(folder)
    try {
      watcher = watch(folder, (kind, name) => {
        if (isFolderDeleted(kind, name)) {
          settleUnwatchable()
          return
        }
        if (name) {
          void check(String(name)).catch(() => {})
        }
      })
      watcher.on('error', settleUnwatchable)
    } catch {
      settleUnwatchable()
    }
  })
}

/**
 * The newest Desktop app key in the folder modified since `since`, for the project when one is
 * given. For a key the watch missed; the file stays where it is.
 */
export async function findGoogleKeyInFolder(
  folder: string,
  args: { since: number; projectId?: string }
): Promise<GoogleSetupFoundKey | null> {
  const names = (await readdir(folder).catch(() => [])).filter((name) =>
    GOOGLE_KEY_FILE_NAME.test(name)
  )
  const candidates = await Promise.all(
    names.map(async (name) => {
      const info = await stat(join(folder, name)).catch(() => null)
      return info?.isFile() &&
        info.mtimeMs >= args.since - CLOCK_SLACK_MS &&
        info.size <= GOOGLE_CLIENT_FILE_MAX_BYTES
        ? { name, modifiedAt: info.mtimeMs }
        : null
    })
  )
  const newestFirst = candidates
    .filter((entry) => entry !== null)
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
  for (const entry of newestFirst) {
    const text = await readFile(join(folder, entry.name), 'utf8').catch(() => null)
    const parsed = text === null ? null : parseGoogleClientFile(text)
    if (text !== null && parsed?.ok && (!args.projectId || parsed.projectId === args.projectId)) {
      return { name: entry.name, text, modifiedAt: entry.modifiedAt }
    }
  }
  return null
}
