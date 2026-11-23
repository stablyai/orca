import type { BrowserReadImageResult } from '../../../../shared/browser/runtime/runtime-browser-contracts'
import { readGuestImageContent } from '../../cdp/commands/cdp-page-image-content'
import { AgentBrowserBridgeAudioCommands } from './agent-browser-bridge-audio-commands'

// Base64 grows a slice by a third; this keeps each reply well under the 4 MiB frame cap.
export const BROWSER_READ_IMAGE_CHUNK_BYTES = 2 * 1024 * 1024

/** The right-click menu items a remote pane draws over a page this host renders. */
export abstract class AgentBrowserBridgePageMenuCommands extends AgentBrowserBridgeAudioCommands {
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
    const { mimeType, bytes } = await readGuestImageContent(wc, url)
    const start = Math.min(Math.max(0, Math.floor(offset)), bytes.length)
    return {
      mimeType,
      size: bytes.length,
      data: bytes.subarray(start, start + BROWSER_READ_IMAGE_CHUNK_BYTES).toString('base64')
    }
  }
}
