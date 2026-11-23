import type { WebContents } from 'electron'
import type { BrowserReadImageResult } from '../../../../shared/browser/runtime/runtime-browser-contracts'
import {
  CLIPBOARD_IMAGE_MAX_SOURCE_BYTES,
  CLIPBOARD_IMAGE_TOO_LARGE_ERROR
} from '../../../../shared/clipboard/clipboard-image'
import { BrowserError } from '../../browser-error'
import { readGuestImageContent } from '../../cdp/commands/cdp-page-image-content'
import { AgentBrowserBridgeAudioCommands } from './agent-browser-bridge-audio-commands'

// Base64 grows a slice by a third; this keeps each reply well under the 4 MiB frame cap.
export const BROWSER_READ_IMAGE_CHUNK_BYTES = 2 * 1024 * 1024
// Long enough for one copy's chunk requests; the bytes are not kept past it.
const READ_IMAGE_REUSE_MS = 30_000

type ReadImage = { url: string; mimeType: string; bytes: Buffer; at: number }

/** The right-click menu items a remote pane draws over a page this host renders. */
export abstract class AgentBrowserBridgePageMenuCommands extends AgentBrowserBridgeAudioCommands {
  private readonly lastReadImage = new WeakMap<WebContents, ReadImage>()

  // Not queued: like find, these act on the person's own menu, not on an agent's command.
  replaceMisspelling(
    word: string,
    worktreeId?: string,
    browserPageId?: string
  ): { replaced: true } {
    this.requireUnqueuedWebContents(worktreeId, browserPageId).replaceMisspelling(word)
    return { replaced: true }
  }

  addWordToDictionary(
    word: string,
    worktreeId?: string,
    browserPageId?: string
  ): { added: boolean } {
    const wc = this.requireUnqueuedWebContents(worktreeId, browserPageId)
    return { added: wc.session.addWordToSpellCheckerDictionary(word) }
  }

  // The download follows this host's rules for the page's downloads, as a local Save Image does.
  saveImage(url: string, worktreeId?: string, browserPageId?: string): { started: true } {
    this.requireUnqueuedWebContents(worktreeId, browserPageId).downloadURL(url)
    return { started: true }
  }

  async readImage(
    url: string,
    offset: number,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserReadImageResult> {
    const wc = this.requireUnqueuedWebContents(worktreeId, browserPageId)
    const start = Math.max(0, Math.floor(offset))
    const cached = this.lastReadImage.get(wc)
    // Later chunks of one copy reuse the first read instead of fetching the whole image again.
    const image =
      start > 0 && cached?.url === url && Date.now() - cached.at < READ_IMAGE_REUSE_MS
        ? cached
        : { url, ...(await readGuestImageContent(wc, url)), at: Date.now() }
    // Refuse here, before any bytes cross the link, what the viewer's clipboard would refuse.
    if (image.bytes.length > CLIPBOARD_IMAGE_MAX_SOURCE_BYTES) {
      this.lastReadImage.delete(wc)
      throw new BrowserError('browser_error', CLIPBOARD_IMAGE_TOO_LARGE_ERROR)
    }
    const end = Math.min(start + BROWSER_READ_IMAGE_CHUNK_BYTES, image.bytes.length)
    if (end < image.bytes.length) {
      this.lastReadImage.set(wc, image)
    } else {
      this.lastReadImage.delete(wc)
    }
    return {
      mimeType: image.mimeType,
      size: image.bytes.length,
      data: image.bytes.subarray(Math.min(start, end), end).toString('base64')
    }
  }
}
