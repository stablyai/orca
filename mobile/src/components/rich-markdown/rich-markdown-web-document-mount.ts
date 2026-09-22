import { createRichMarkdownEditorDocument } from './create-rich-markdown-editor-document'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import { richMarkdownEditorStyle } from './document-style'
import { scopeDocumentStyleToHost } from '../../terminal/terminal-webview-html/document-style-scoping'
import type { RichMarkdownEditorApi, RichMarkdownUrlPromptKind } from './document-host-seams'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'

/**
 * The rich Markdown editor document, mounted in the page instead of in a WebView.
 *
 * Same program: the factory the WebView's script is bundled from, called here with the page's own
 * hooks instead of the WebView's window. What the WebView's HTML gave the document — a stylesheet,
 * the markup it reads its surface out of, a `postMessage` back to React Native and a `prompt` for
 * the two commands that need a URL — this supplies instead, through the seams and the host element.
 *
 * A call is a document. Nothing here is shared between two of them and nothing is reset: each call
 * builds its own scope and reads its own surface, so a second editor on the page cannot reach the
 * first one's state and a stale callback from a mount that has gone reads the scope it closed over.
 */

export type RichMarkdownWebDocument = {
  /** What the WebView reaches through its injected global, held directly. */
  send: RichMarkdownEditorApi
  dispose: () => void
}

/** What the page has to answer that the window cannot. */
export type RichMarkdownWebDocumentHooks = {
  postToHost: (message: MobileRichMarkdownEditorMessage) => void
  promptForUrl: (kind: RichMarkdownUrlPromptKind) => Promise<string | null>
}

const STYLE_ELEMENT_ID = 'orca-rich-markdown-document-style'

/** The class the host carries, and the prefix every injected rule is held under. */
export const RICH_MARKDOWN_HOST_CLASS = 'orca-rich-markdown-document-host'

/**
 * The stylesheet, planted in the head once per page and reaching only inside the host.
 *
 * The document's rules are written against element names — `h1`, `p`, `code`, `pre`, `a` — so the
 * sheet the WebView's `<head>` carries would restyle every screen the shell can show and keep
 * doing it after the editor is gone. `scopeDocumentStyleToHost` holds all of them under the host's
 * class, the document's own four included: the host element *is* this editor's page, so the
 * variables the sheet reads, its surface colour and its font belong on it.
 *
 * Left in the head after unmount, like the terminal's: it matches nothing once the host has
 * dropped the class, and the next mount wants it back.
 */
function ensureDocumentStyle() {
  if (document.getElementById(STYLE_ELEMENT_ID)) {
    return
  }
  const style = document.createElement('style')
  style.id = STYLE_ELEMENT_ID
  style.textContent = scopeDocumentStyleToHost(
    richMarkdownEditorStyle(),
    `.${RICH_MARKDOWN_HOST_CLASS}`
  )
  document.head.appendChild(style)
}

/**
 * The document, mounted: style, markup, one call, and the handle that stops it.
 *
 * Synchronous, because the modules are a static import and building a document is a function call.
 * A caller's cleanup can therefore never arrive before there is something to clean up.
 */
export function mountRichMarkdownWebDocument(
  host: HTMLElement,
  hooks: RichMarkdownWebDocumentHooks
): RichMarkdownWebDocument {
  ensureDocumentStyle()
  host.classList.add(RICH_MARKDOWN_HOST_CLASS)
  host.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const started = startDocumentOrGiveTheHostBack(host, hooks)
  return {
    send: started.send,
    dispose: () => {
      started.stop()
      host.innerHTML = ''
      // The sheet stays in the head; the class does not, so every rule in it matches nothing again
      // the moment the editor is gone.
      host.classList.remove(RICH_MARKDOWN_HOST_CLASS)
    }
  }
}

/**
 * The call, and the host given back if it throws.
 *
 * A start that throws is unwound inside the factory, which leaves the document stopped and the
 * page holding this function's own two edits: the markup and the class. Neither has an owner once
 * there is no handle.
 */
function startDocumentOrGiveTheHostBack(host: HTMLElement, hooks: RichMarkdownWebDocumentHooks) {
  try {
    return createRichMarkdownEditorDocument({
      // The mount's own element, so two editors on one page read their own surfaces: the markup's
      // id is the same in both hosts, and a stack transition keeps the outgoing screen mounted
      // while the incoming one starts.
      root: host,

      // Ruling 19: on the page `window.ReactNativeWebView` is the *shell's* bridge, so an editor
      // message posted through it would put editor JSON into the bridge's own channel.
      postToHost: hooks.postToHost,

      // Measured to return null in both shells, neither of which implements the delegate the
      // dialog needs, so Link and Image did nothing at all. The page answers with a modal.
      promptForUrl: hooks.promptForUrl,

      // None, deliberately. The document's `visualViewport` reads and the screen's own
      // `keyboard-occlusion.web.ts` are the same measurement of the same viewport with the same
      // formula, so reporting an inset here would lift the screen's bar twice.
      keyboardInsetSource: () => null
    })
  } catch (error) {
    host.innerHTML = ''
    host.classList.remove(RICH_MARKDOWN_HOST_CLASS)
    throw error
  }
}
