import { createTerminalDocument } from './create-terminal-document'

/**
 * The WebView's document: one call, no host.
 *
 * Inside the WebView every seam is the window read the document always did, so the host argument is
 * empty and the defaults answer. The handle is dropped on purpose — the WebView's transport is the
 * `message` listeners the document installs for itself, and nothing there ever stops it.
 *
 * This file exists to be bundled. It is the entry `build-terminal-document-script.mjs` hands to
 * esbuild, and the only module in the document with a statement at its top level.
 */
createTerminalDocument()
