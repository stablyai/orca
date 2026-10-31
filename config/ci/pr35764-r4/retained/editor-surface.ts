import { Editor, type AnyExtension } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import {
  DragSelectionGuard,
  completeRichMarkdownSelection,
  richMarkdownSelectionCompletionEvents
} from '@/components/editor/drag-selection-guard'
import { focusRichMarkdownEditorFromSearch } from '@/components/editor/rich-markdown-search-focus'

export function findTextPosition(editor: Editor, text: string): number {
  let position: number | null = null
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === text) {
      position = pos
      return false
    }
    return true
  })
  if (position === null) {
    throw new Error(`Expected editor text: ${text}`)
  }
  return position
}

export function createSurface(content: string, extensions: AnyExtension[] = []) {
  const root = document.createElement('div')
  root.className = 'rich-markdown-editor-shell'
  document.body.append(root)
  const editor = new Editor({
    extensions: [StarterKit, TableKit, DragSelectionGuard, ...extensions],
    content,
    editorProps: {
      handleDOMEvents: {
        ...richMarkdownSelectionCompletionEvents,
        mousedown: (view, event) => {
          completeRichMarkdownSelection(view)
          focusRichMarkdownEditorFromSearch(event, view)
          return false
        }
      }
    }
  })
  root.append(editor.view.dom)
  const search = document.createElement('div')
  search.className = 'rich-markdown-search'
  const input = document.createElement('input')
  const replace = document.createElement('input')
  search.append(input, replace)
  root.append(search)
  return { editor, input, replace }
}
