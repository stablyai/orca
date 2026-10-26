import { createRichMarkdownEditorDocument } from './create-rich-markdown-editor-document'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import { richMarkdownEditorStyle } from './document-style'
import { scopeDocumentStyleToHost } from '../../style-scoping/document-style-scoping'
import type { RichMarkdownEditorApi, RichMarkdownUrlPromptKind } from './document-host-seams'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'

// Mount owns style/markup/hooks and fresh editor scope; overlapping editors and stale callbacks cannot access another mount’s state.

export type RichMarkdownWebDocument = {
  /** The running document's API. */
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

// Plant sheet once per page, scoped to host class; move document-wide theme/color/font globals onto host itself.
// Leave sheet in head on unmount: removing host class makes it inert, and next mount reuses it.
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

// Mount static modules synchronously so cleanup cannot arrive before disposal handle exists.
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
      // Keep shared sheet but remove host class so its rules stop matching immediately.
      host.classList.remove(RICH_MARKDOWN_HOST_CLASS)
    }
  }
}

// Factory unwinds failed start; remove mount’s markup/class too because no handle remains to own them.
function startDocumentOrGiveTheHostBack(host: HTMLElement, hooks: RichMarkdownWebDocumentHooks) {
  try {
    return createRichMarkdownEditorDocument({
      // Scope surface lookup to own host; transitions overlap editors with identical #editor id.
      root: host,

      // Send editor JSON via host hook, never page’s shell-owned ReactNativeWebView bridge (ruling 19).
      postToHost: hooks.postToHost,

      // Use page modal: both shells lack prompt delegate and return null, so Link/Image otherwise do nothing.
      promptForUrl: hooks.promptForUrl,

      // Omit inset source: document and screen read same visualViewport formula, and reporting twice double-lifts screen bar.
      keyboardInsetSource: () => null
    })
  } catch (error) {
    host.innerHTML = ''
    host.classList.remove(RICH_MARKDOWN_HOST_CLASS)
    throw error
  }
}
