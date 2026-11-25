import { createRichMarkdownEditorScope } from './document/document-scope'
import {
  currentMarkdown,
  setEditable,
  setMarkdown,
  stopEditorContent
} from './editing/editor-content'
import { startEditorListeners, stopEditorListeners } from './editing/editor-listeners'
import { startEditorSurface } from './editing/editor-surface'
import { startHostBridge } from './document/host-bridge'
import { dismissKeyboard } from './editing/keyboard-dismiss'
import { runCommand } from './editing/editor-commands'
import { startKeyboardInset, stopKeyboardInset } from './editing/keyboard-inset'
import type { RichMarkdownEditorScope } from './document/document-scope'
import type {
  RichMarkdownEditorDocument,
  RichMarkdownEditorHost
} from './document/document-host-seams'

// Each mount owns local editor scope so overlapping editors/listeners never read another mount.
// Start in order: read surface, install listeners, start keyboard measurement, then announce ready.
export function createRichMarkdownEditorDocument(
  host: RichMarkdownEditorHost
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

// Undo whole sequence if any start throws; stops safely ignore unstarted modules. Export order so tests reuse real document setup instead of duplicating it.
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

// Stop in reverse dependency order; cancel timer last, after listeners that could schedule it.
export function stopRichMarkdownEditorDocument(scope: RichMarkdownEditorScope) {
  scope.stopped = true
  stopKeyboardInset(scope)
  stopEditorListeners(scope)
  stopEditorContent(scope)
}
