// Import file for an agent on another host, for a key its browser saved in the agent's workspace
// that no claim took (an older desktop that can't say what started a download). The file this host
// recorded the setup's page downloading is used; otherwise the owner picks one. A file is removed
// only after it was imported, and only if it is still the same file that was read.
import { randomUUID } from 'node:crypto'
import { readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Bot } from '../../shared/bot-types'
import type { GoogleSetupKeyCandidate } from '../../shared/rpc-contract/google-setup-params'
import { GOOGLE_CLIENT_FILE_MAX_BYTES } from '../../shared/google/google-client-config'
import { googleSetupAwaitsKey } from '../../shared/google/google-setup-run'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { botHomeFolder } from '../bots/bot-home'
import { BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY } from '../runtime/browser/downloads/browser-client-download-transfers'
import { clientDownloadCommits } from '../runtime/browser/downloads/client-download-provenance'
import { parseGoogleClientFile } from './google-client-file'
import { getGoogleConnect } from './google-connect'
import { GOOGLE_KEY_FILE_NAME } from './google-key-download-watch'
import { googleSetupRuns } from './google-setup-runs'

type SavedKeyCandidate = GoogleSetupKeyCandidate

export type SavedKeyImport = { found: true } | { found: false; candidates: SavedKeyCandidate[] }

const MAX_CANDIDATES = 10

async function fileId(path: string): Promise<{ id: string; mtimeMs: number; size: number } | null> {
  const info = await stat(path).catch(() => null)
  return info?.isFile()
    ? {
        id: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`,
        mtimeMs: info.mtimeMs,
        size: info.size
      }
    : null
}

/** The run's page's own download of a key, when this host recorded exactly one since it started. */
function recordedKey(
  bot: Pick<Bot, 'folderWorkspaceId'>,
  page: string,
  since: number
): { name: string; committedAt: number } | null {
  const recorded = clientDownloadCommits(
    (commit) =>
      commit.workspaceId === folderWorkspaceKey(bot.folderWorkspaceId) &&
      commit.browserPageId === page &&
      commit.committedAt >= since &&
      GOOGLE_KEY_FILE_NAME.test(basename(commit.workspaceRelativePath))
  )
  return recorded.length === 1
    ? { name: basename(recorded[0].workspaceRelativePath), committedAt: recorded[0].committedAt }
    : null
}

// A file written after its download was committed is some other file at the same name.
const COMMIT_CLOCK_SLACK_MS = 1_000

/** Puts a file that wasn't imported back under its name, or beside it if that name is taken now. */
async function restore(claimed: string, path: string): Promise<void> {
  const free = (await fileId(path)) === null
  await rename(claimed, free ? path : path.replace(/\.json$/, ` (${Date.now()}).json`))
}

const CLAIM_PREFIX = '.importing-'
// An import holds its claim for moments; one older than this was cut short (a crash).
const STRANDED_CLAIM_MS = 60_000

/** Puts back keys an interrupted import left under a hidden claim name, so the owner sees them. */
async function recoverStrandedClaims(folder: string): Promise<void> {
  for (const name of await readdir(folder).catch(() => [])) {
    const startedAt = Number(name.slice(CLAIM_PREFIX.length).split('-')[0])
    if (name.startsWith(CLAIM_PREFIX) && Date.now() - startedAt > STRANDED_CLAIM_MS) {
      await restore(join(folder, name), join(folder, `client_secret_recovered-${startedAt}.json`))
    }
  }
}

async function candidates(folder: string): Promise<SavedKeyCandidate[]> {
  const names = (await readdir(folder).catch(() => [])).filter((name) =>
    GOOGLE_KEY_FILE_NAME.test(name)
  )
  const found: SavedKeyCandidate[] = []
  for (const name of names) {
    const file = await fileId(join(folder, name))
    if (file) {
      found.push({ name, id: file.id, savedAt: file.mtimeMs })
    }
  }
  return found.sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_CANDIDATES)
}

export async function importGoogleSetupKeySavedHere(
  bot: Pick<Bot, 'id' | 'folder' | 'folderWorkspaceId'>,
  keyArrived: () => Promise<unknown>,
  pick?: { name: string; id: string }
): Promise<SavedKeyImport> {
  const run = googleSetupRuns().get(bot.id)
  const connect = getGoogleConnect()
  if (!run || !googleSetupAwaitsKey(run) || !connect) {
    return { found: false, candidates: [] }
  }
  const folder = join(botHomeFolder(bot), BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY)
  await recoverStrandedClaims(folder)
  let name = pick ? basename(pick.name) : null
  if (!pick && run.browserPageId) {
    const recorded = recordedKey(bot, run.browserPageId, run.startedAt)
    const file = recorded && (await fileId(join(folder, recorded.name)))
    // Gone, or replaced since the page downloaded it: the owner picks instead.
    if (recorded && file && file.mtimeMs <= recorded.committedAt + COMMIT_CLOCK_SLACK_MS) {
      name = recorded.name
    }
  }
  if (!name) {
    return { found: false, candidates: await candidates(folder) }
  }
  const path = join(folder, name)
  const before = await fileId(path)
  if (!before || (pick && pick.id !== before.id)) {
    throw new Error('That key file changed or is gone. Pick it again.')
  }
  if (before.size > GOOGLE_CLIENT_FILE_MAX_BYTES) {
    throw new Error('That file is too large to be a Google app key.')
  }
  // Moved aside first, so what is read, imported and removed is this file even if another
  // download takes its name meanwhile.
  const claimed = join(folder, `${CLAIM_PREFIX}${Date.now()}-${randomUUID()}`)
  await rename(path, claimed)
  const putBack = (): Promise<void> => restore(claimed, path)
  if ((await fileId(claimed))?.id !== before.id) {
    await putBack()
    throw new Error('That key file changed or is gone. Pick it again.')
  }
  let text: string
  try {
    text = await readFile(claimed, 'utf8')
  } catch (error) {
    await putBack()
    throw error
  }
  const parsed = parseGoogleClientFile(text)
  if (!parsed.ok) {
    await putBack()
    throw new Error(parsed.message)
  }
  if (parsed.projectId && run.projectId && parsed.projectId !== run.projectId) {
    await putBack()
    throw new Error(`That key is for project ${parsed.projectId}, not ${run.projectId}.`)
  }
  // Cancelled or started over while reading: nothing is imported, and the file stays.
  const stillWaiting = (): boolean => {
    const now = googleSetupRuns().get(bot.id)
    return now?.id === run.id && googleSetupAwaitsKey(now)
  }
  if (!stillWaiting()) {
    await putBack()
    return { found: false, candidates: [] }
  }
  try {
    await connect.importClient(text)
  } catch (error) {
    await putBack()
    throw error
  }
  // The key is in: a failed cleanup is logged, and the setup still moves on.
  await rm(claimed, { force: true }).catch((error: unknown) => {
    console.error('[google-setup] could not delete the imported key file', error)
  })
  if (stillWaiting()) {
    await keyArrived()
  }
  return { found: true }
}
