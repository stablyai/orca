import { clipboard } from 'electron'
import { clipboardFormatSnapshot } from './clipboard-formats'
import { readClipboardPlainText } from './clipboard-plain-text-read'
import { readClipboardCopiedFilePaths } from './clipboard-copied-file-paths'
import { readClipboardImageSource } from './clipboard-image-source'
import { clipboardHtmlMayHaveLinks } from '../../../shared/clipboard/clipboard-link-html'
import { assertClipboardTextWithinLimitWithYield } from '../../../shared/clipboard/clipboard-text'
import type {
  ClipboardPasteContent,
  ReadClipboardPasteContentOptions
} from '../../../shared/clipboard/clipboard-paste-content'

/** One clipboard.read() per paste: on macOS each read waits on the pasteboard, and a stalled source app holds main for each one. */
export async function readClipboardPasteContent(
  options: ReadClipboardPasteContentOptions = {},
  /** Text-only senders (dashboard popouts) never get file, HTML or image access. */
  textOnly = false
): Promise<ClipboardPasteContent> {
  const reader = clipboardFormatSnapshot()
  const text = await assertClipboardTextWithinLimitWithYield(
    await readClipboardPlainText({ ...reader, readText: () => clipboard.readText() }),
    options
  )
  if (textOnly) {
    return { text, filePaths: [], linkHtml: '', hasImage: false }
  }
  const filePaths = await readClipboardCopiedFilePaths(reader)
  const linkHtml = options.linkHtml
    ? await reader
        .readHtml()
        .then((html) => (clipboardHtmlMayHaveLinks(html) ? html : ''))
        .catch(() => '')
    : ''
  const hasImage =
    options.probeImage || text === ''
      ? await readClipboardImageSource(reader).then(
          (source) => source !== null,
          () => false
        )
      : false
  return { text, filePaths, linkHtml, hasImage }
}
