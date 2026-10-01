import { createRichMarkdownEditorDocument } from './create-rich-markdown-editor-document'

/**
 * The WebView's document: one call, no host, and the handle hung where the host can reach it.
 *
 * Inside the WebView every seam is the window read the document always did, so the host argument
 * is empty and the defaults answer. The host's transport is `injectJavaScript`, which is a script
 * evaluated in this page rather than a message, so the handle has to be a global — and `stop` is
 * dropped on purpose, because there the document outlives nothing.
 *
 * This file exists to be bundled. It is the entry `build-rich-markdown-editor-script.mjs` hands to
 * esbuild, and the only module in the document with a statement at its top level.
 */
window.__orcaRichMarkdown = createRichMarkdownEditorDocument().send
