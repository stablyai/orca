// The Google app key, taken as Orca's browser downloads it from an agent's setup page. The claim is
// made when the download starts, for the one run waiting on that page in that agent's workspace, and
// the bytes go to host-private staging (never the workspace) until they are imported or dropped.
import { randomUUID } from 'node:crypto'
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { GOOGLE_CLIENT_FILE_MAX_BYTES } from '../../shared/google/google-client-config'
import {
  googleSetupAwaitsKey,
  isGoogleClientsPage,
  type GoogleSetupRun
} from '../../shared/google/google-setup-run'
import type { StandingDownloadClaimResolver } from '../browser/guest-lifecycle/manager/downloads/browser-manager-download-creation'
import type { ClientDownloadClaimant } from '../runtime/browser/downloads/client-download-claims'
import { parseGoogleClientFile } from './google-client-file'
import { GOOGLE_KEY_FILE_NAME } from './google-key-download-watch'

export type GoogleSetupKeyDownloadDeps = {
  runs: () => GoogleSetupRun[]
  /** The workspace an agent's browser pages belong to. */
  botWorkspace: (botId: string) => string | null
  /** Saves the key as this host's Google app; throws why it isn't one. */
  importKey: (text: string) => void | Promise<void>
  keyArrived: (botId: string) => Promise<unknown>
  keyRefused: (botId: string, reason: string) => Promise<unknown>
}

/** Where the person is told a claimed key download went, on every kind of page. */
const GOOGLE_SETUP_DOWNLOAD_LABEL = 'Google setup in Orca'

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

/** A download as it starts: which page, in which workspace, from which document. */
export type GoogleSetupKeyDownloadStart = {
  browserPageId: string
  workspaceId: string | null
  filename: string
  documentUrl: string
}

/** The one run a key download starting on this page belongs to; null when none, or more than one
 *  run names the page (a stale page pick), or the page isn't in that agent's workspace. */
function claimingRun(
  deps: GoogleSetupKeyDownloadDeps,
  start: GoogleSetupKeyDownloadStart
): GoogleSetupRun | null {
  if (!GOOGLE_KEY_FILE_NAME.test(start.filename) || !isGoogleClientsPage(start.documentUrl)) {
    return null
  }
  const onPage = deps
    .runs()
    .filter((run) => run.browserPageId === start.browserPageId && googleSetupAwaitsKey(run))
  if (onPage.length !== 1) {
    return null
  }
  const [run] = onPage
  return start.workspaceId !== null && deps.botWorkspace(run.botId) === start.workspaceId
    ? run
    : null
}

/** The downloaded key's bytes in staging: read once, then always removed. */
type KeyFile = {
  /** The text, or null when it is larger than `maxBytes`. */
  read: (maxBytes: number) => Promise<string | null>
  remove: () => Promise<void>
}

/** This host's own browser: Chromium saves the key into Orca's private `stagingDir`. */
export function googleSetupKeyDownloadClaim(
  deps: GoogleSetupKeyDownloadDeps,
  host: { stagingDir: string; workspaceOfPage: (browserPageId: string) => string | null }
): StandingDownloadClaimResolver {
  return ({ browserTabId, filename, documentUrl }) => {
    const start = {
      browserPageId: browserTabId,
      workspaceId: host.workspaceOfPage(browserTabId),
      filename,
      documentUrl
    }
    const run = claimingRun(deps, start)
    if (!run) {
      return null
    }
    // Chromium creates the folder when it saves there.
    const savePath = join(host.stagingDir, `${randomUUID()}.json`)
    const file: KeyFile = {
      read: async (maxBytes) =>
        (await stat(savePath)).size > maxBytes ? null : readFile(savePath, 'utf8'),
      remove: () => rm(savePath, { force: true })
    }
    return {
      savePath,
      label: GOOGLE_SETUP_DOWNLOAD_LABEL,
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

/** A paired desktop's download, claimed when it begins; its bytes stay in this host's memory. */
export function googleSetupClientDownloadClaimant(
  deps: GoogleSetupKeyDownloadDeps
): ClientDownloadClaimant {
  return (start) => {
    const run = claimingRun(deps, start)
    if (!run) {
      return null
    }
    return {
      maxBytes: GOOGLE_CLIENT_FILE_MAX_BYTES,
      // The desktop shows where it went; the key itself is never saved in the workspace.
      label: GOOGLE_SETUP_DOWNLOAD_LABEL,
      take: (download) => {
        const file: KeyFile = {
          read: async () => ('bytes' in download ? download.bytes.toString('utf8') : null),
          remove: async () => {}
        }
        return takeKey(deps, run, 'reason' in download ? { reason: download.reason, file } : file)
      }
    }
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

/** Imports the key for the run that claimed it, if that run still waits for it; the staged copy is
 *  removed whatever happens, and a failed removal is reported, never hidden. */
async function takeKey(
  deps: GoogleSetupKeyDownloadDeps,
  armed: GoogleSetupRun,
  download: KeyFile | { reason: string; file: KeyFile }
): Promise<void> {
  const file = 'file' in download ? download.file : download
  const live = (): boolean =>
    deps
      .runs()
      .some(
        (run) =>
          run.id === armed.id &&
          run.browserPageId === armed.browserPageId &&
          googleSetupAwaitsKey(run)
      )
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
    await file.remove().catch((error: unknown) => {
      console.error('[google-setup] could not delete the staged key download', error)
    })
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
