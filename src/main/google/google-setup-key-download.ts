// The Google app key, taken as Orca's browser downloads it from a bot's setup page: however Download
// JSON was clicked, the key goes to Orca (never to Downloads) and the client step finishes.
import { randomUUID } from 'node:crypto'
import { readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GOOGLE_CLIENT_FILE_MAX_BYTES } from '../../shared/google/google-client-config'
import {
  googleSetupAwaitsKey,
  isGoogleClientsPage,
  type GoogleSetupRun
} from '../../shared/google/google-setup-run'
import type { StandingDownloadClaimResolver } from '../browser/guest-lifecycle/manager/downloads/browser-manager-download-creation'
import { parseGoogleClientFile } from './google-client-file'
import { GOOGLE_KEY_FILE_NAME } from './google-key-download-watch'

export type GoogleSetupKeyDownloadDeps = {
  runs: () => GoogleSetupRun[]
  /** Saves the key as this host's Google app; throws why it isn't one. */
  importKey: (text: string) => void | Promise<void>
  keyArrived: (botId: string) => Promise<unknown>
  keyRefused: (botId: string, reason: string) => Promise<unknown>
}

/** The bot's line when a download from its setup page isn't a key Orca can use. */
export function googleSetupKeyRefusedLine(reason: string): string {
  return `The key download didn't reach Orca: ${reason}`
}

/** Whether a click's effects must leave out this page's text: Google Cloud's client page in a setup's
 *  tab. The Create dialog shows the client secret until it's closed, and saving the key doesn't
 *  close it, so this holds whatever the run's state rather than until the key arrives. */
export function googleSetupWithholdsPageText(
  runs: readonly GoogleSetupRun[],
  page: { browserPageId: string; url: string }
): boolean {
  return (
    isGoogleClientsPage(page.url) && runs.some((run) => run.browserPageId === page.browserPageId)
  )
}

/** The run on this page that still waits for its key. */
function waitingRun(
  deps: GoogleSetupKeyDownloadDeps,
  browserTabId: string
): GoogleSetupRun | undefined {
  return deps
    .runs()
    .find((entry) => entry.browserPageId === browserTabId && googleSetupAwaitsKey(entry))
}

/** The downloaded key's bytes wherever they landed: read once, then always removed. */
type KeyFile = {
  /** The text, or null when it is larger than `maxBytes`. */
  read: (maxBytes: number) => Promise<string | null>
  remove: () => Promise<void>
}

/** A download this host's browser saved, or a client's that the file channel committed here. */
export type GoogleSetupKeyDownload = {
  browserPageId: string
  filename: string
  /** Where the page was when the download started; a client's page may name more than one. */
  urls: readonly string[]
}

/** The run a key download from this page belongs to, or null when no setup takes it. */
function claimingRun(
  deps: GoogleSetupKeyDownloadDeps,
  download: GoogleSetupKeyDownload
): GoogleSetupRun | null {
  if (!GOOGLE_KEY_FILE_NAME.test(download.filename) || !download.urls.some(isGoogleClientsPage)) {
    return null
  }
  return waitingRun(deps, download.browserPageId) ?? null
}

/**
 * Claims a key download made by Google Cloud's client page in a tab a running setup waits on. The
 * claim belongs to that run: a run cancelled or started over meanwhile only gets the file deleted.
 */
export function googleSetupKeyDownloadClaim(
  deps: GoogleSetupKeyDownloadDeps
): StandingDownloadClaimResolver {
  return ({ browserTabId, filename, documentUrl }) => {
    const run = claimingRun(deps, { browserPageId: browserTabId, filename, urls: [documentUrl] })
    if (!run) {
      return null
    }
    const savePath = join(tmpdir(), `orca-google-app-${randomUUID()}.json`)
    const file: KeyFile = {
      read: async (maxBytes) =>
        (await stat(savePath)).size > maxBytes ? null : readFile(savePath, 'utf8'),
      remove: () => rm(savePath, { force: true })
    }
    return {
      savePath,
      finish: (event) =>
        void takeKey(
          deps,
          run,
          event.status === 'completed'
            ? file
            : { reason: event.error ?? `the download was ${event.status}.`, file }
        )
    }
  }
}

/** A key a paired client's browser downloaded into this host, already saved in the page's workspace:
 *  taken like a local download, so the file never stays where the agent could read it. */
export function googleSetupCommittedKeyClaim(
  deps: GoogleSetupKeyDownloadDeps
): (download: GoogleSetupKeyDownload & KeyFile) => Promise<boolean> {
  return async (download) => {
    const run = claimingRun(deps, download)
    if (!run) {
      return false
    }
    await takeKey(deps, run, download)
    return true
  }
}

/** The key's text, or why it isn't this setup's key. */
async function readKey(
  run: GoogleSetupRun,
  file: KeyFile
): Promise<{ text: string } | { reason: string }> {
  const text = await file.read(GOOGLE_CLIENT_FILE_MAX_BYTES)
  if (text === null) {
    return { reason: 'the file is too large to be a Google app key.' }
  }
  const parsed = parseGoogleClientFile(text)
  if (!parsed.ok) {
    return { reason: parsed.message }
  }
  if (parsed.projectId && run.projectId && parsed.projectId !== run.projectId) {
    return { reason: `the key is for project ${parsed.projectId}, not ${run.projectId}.` }
  }
  return { text }
}

async function takeKey(
  deps: GoogleSetupKeyDownloadDeps,
  armed: GoogleSetupRun,
  download: KeyFile | { reason: string; file: KeyFile }
): Promise<void> {
  const file = 'file' in download ? download.file : download
  // Still the run that armed the claim, on its page, waiting for its key.
  const live = (): boolean => waitingRun(deps, armed.browserPageId ?? '')?.id === armed.id
  let outcome: { ok: true } | { ok: false; reason: string } | null = null
  try {
    const key = 'reason' in download ? download : await readKey(armed, file)
    if (!live()) {
      return
    }
    if ('reason' in key) {
      outcome = { ok: false, reason: key.reason }
    } else {
      await deps.importKey(key.text)
      outcome = { ok: true }
    }
  } catch (error) {
    outcome = { ok: false, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    // The secret's file never outlives the import, whatever the bot's chat is doing.
    await file.remove().catch(() => {})
  }
  if (!outcome || !live()) {
    return
  }
  const told = outcome.ok
    ? deps.keyArrived(armed.botId)
    : deps.keyRefused(armed.botId, outcome.reason)
  await told.catch((error: unknown) => {
    console.warn('[google-setup] could not report the key download', error)
  })
}
