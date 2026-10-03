import { createRichMarkdownEditorScope } from './document-scope'
import { currentMarkdown, setEditable, setMarkdown, stopEditorContent } from './editor-content'
import { startEditorListeners, stopEditorListeners } from './editor-listeners'
import { startEditorSurface } from './editor-surface'
import { startHostBridge } from './host-bridge'
import { dismissKeyboard } from './keyboard-dismiss'
import { runCommand } from './editor-commands'
import { startKeyboardInset, stopKeyboardInset } from './keyboard-inset'
import type { RichMarkdownEditorScope } from './document-scope'
import type { RichMarkdownEditorDocument, RichMarkdownEditorHost } from './document-host-seams'

/**
 * One rich Markdown editor document, started.
 *
 * The program both hosts run: the WebView loads it as a bundled script that calls this once with
 * no host, and the page imports it and calls it per mount with its own hooks. A call owns
 * everything it touches — the scope below is local to it — so two editors on one page are two
 * editors, and a listener left over from a mount that has gone reads the scope it closed over
 * rather than the live one.
 *
 * The sequence is here rather than derived from a list, because it *is* the document's shape: the
 * surface is read, the listeners that need it are installed, the keyboard measurement starts, and
 * only then is the host told the document is ready.
 */
export function createRichMarkdownEditorDocument(
  host: RichMarkdownEditorHost = {}
): RichMarkdownEditorDocument {
  const scope = createRichMarkdownEditorScope(host)
  startRichMarkdownEditorDocument(scope)
  return {
    send: {
      setMarkdown: (markdown, generation) => {
        setMarkdown(scope, markdown, generation)
      },
      setEditable: (editable) => {
        setEditable(scope, editable)
      },
      runCommand: (command) => runCommand(scope, command),
      currentMarkdown: () => currentMarkdown(scope),
      dismissKeyboard: () => {
        dismissKeyboard(scope)
      }
    },
    stop: () => {
      stopRichMarkdownEditorDocument(scope)
    }
  }
}

/**
 * Every module's start, in the order the document runs them.
 *
 * A start that throws has left the ones before it holding the surface's listeners or the
 * viewport's, and there is no handle for anyone to stop with, so the undo runs here. Every stop is
 * a no-op against a start that never ran, which is what makes the whole sequence the right undo
 * for a partial one.
 *
 * Exported because a test that drives one module still needs the surface and the listeners the
 * others put in place, and the order is not a thing to write twice.
 */
export function startRichMarkdownEditorDocument(scope: RichMarkdownEditorScope) {
  try {
    startEditorSurface(scope)
    startEditorListeners(scope)
    startKeyboardInset(scope)
    startHostBridge(scope)
  } catch (error) {
    stopRichMarkdownEditorDocument(scope)
    throw error
  }
}

/**
 * The undo, in reverse, so nothing is torn down under something still using it, with the pending
 * timer taken back last — after the listeners that could have scheduled another one are gone.
 */
export function stopRichMarkdownEditorDocument(scope: RichMarkdownEditorScope) {
  scope.stopped = true
  stopKeyboardInset(scope)
  stopEditorListeners(scope)
  stopEditorContent(scope)
}
