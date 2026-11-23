import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { BrowserError } from '../../../browser/browser-error'
import { BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES } from '../../../../shared/browser/client-hosting/browser-client-file-channel-protocol'
import {
  AGENT_DOWNLOAD_REPLY_DEADLINE_MS,
  AGENT_DOWNLOAD_START_TIMEOUT_MS
} from '../../../../shared/browser/downloads/agent-download-timing'
import { withTimeout } from '../../../../shared/concurrency/promise-timeout-fallback'
import { claimNextClientDownload } from '../downloads/client-download-claims'

/** `download --path` on a paired desktop's page: the desktop clicks, and its download relay
 *  hands the file to this host, which saves it at the path as a download on its own page would. */
export async function downloadClientPageToPath(
  params: Record<string, unknown>,
  browserPageId: string,
  click: (params: Record<string, unknown>) => Promise<unknown>
): Promise<{ path: string }> {
  // The desktop refuses a download that names a path, which would be one on its own disk.
  const { path: savePath, ...clickParams } = params
  if (typeof savePath !== 'string' || !path.isAbsolute(savePath)) {
    throw new BrowserError(
      'invalid_argument',
      `--path must be an absolute path: ${String(savePath)}`
    )
  }
  const replyDeadline = Date.now() + AGENT_DOWNLOAD_REPLY_DEADLINE_MS
  await mkdir(path.dirname(savePath), { recursive: true })
  const saved = Promise.withResolvers<string | null>()
  const claim = claimNextClientDownload(browserPageId, {
    maxBytes: BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES,
    label: savePath,
    // The desktop reports where the file went, so it must hear when saving it failed.
    confirmsTake: true,
    take: async (download) => {
      if ('reason' in download) {
        saved.resolve(`The download failed: ${download.reason}`)
        return
      }
      try {
        await writeFile(savePath, download.bytes)
        saved.resolve(null)
      } catch (error) {
        saved.resolve(`Could not save the download to ${savePath}: ${String(error)}`)
        throw error
      }
    }
  })
  if (!claim) {
    throw new BrowserError(
      'browser_download_busy',
      'Another download is already waiting on this tab or its popups.'
    )
  }
  try {
    const clicked = await click(clickParams)
    // The desktop waits for the download to start, and sends its begin ahead of the click's result.
    const desktopSawStart = !isRecord(clicked) || clicked.downloadStarted !== false
    if (
      !desktopSawStart ||
      !(await withTimeout(
        claim.began.then(() => true),
        AGENT_DOWNLOAD_START_TIMEOUT_MS,
        false
      ))
    ) {
      throw new BrowserError(
        'browser_download_not_started',
        `Clicking ${String(clickParams.selector)} did not start a download within ${AGENT_DOWNLOAD_START_TIMEOUT_MS / 1000}s.`
      )
    }
    const failure = await withTimeout<string | null | undefined>(
      saved.promise,
      Math.max(0, replyDeadline - Date.now()),
      undefined
    )
    if (failure === undefined) {
      throw new BrowserError(
        'browser_download_in_progress',
        `The download is still in progress and will be saved to ${savePath}.`
      )
    }
    if (failure !== null) {
      throw new BrowserError('browser_download_failed', failure)
    }
    return { path: savePath }
  } finally {
    claim.release()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
