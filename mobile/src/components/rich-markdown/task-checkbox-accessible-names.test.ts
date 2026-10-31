// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { createRichMarkdownEditorDocument } from './create-rich-markdown-editor-document'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import { quietRichMarkdownEditorHost } from './rich-markdown-editor-host.test-support'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'

const stopDocuments: (() => void)[] = []

afterEach(() => {
  stopDocuments.splice(0).forEach((stop) => stop())
  document.body.innerHTML = ''
})

function mount(markdown: string) {
  const root = document.createElement('div')
  root.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  document.body.append(root)
  const messages: MobileRichMarkdownEditorMessage[] = []
  const editorDocument = createRichMarkdownEditorDocument({
    ...quietRichMarkdownEditorHost(),
    root,
    postToHost: (message) => messages.push(message)
  })
  stopDocuments.push(editorDocument.stop)
  editorDocument.send.setMarkdown(markdown, 7)
  const surface = root.querySelector('#editor')!
  const names = () =>
    Array.from(root.querySelectorAll('input')).map((input) => input.getAttribute('aria-label'))
  return { root, surface, names, messages, send: editorDocument.send }
}

it('names plain, formatted and nested task controls without serializing their labels', () => {
  const markdown = '- [ ] First task\n- [x] **Second task**\n  - [ ] Nested task'
  const editor = mount(markdown)
  expect(editor.names()).toEqual(['First task', 'Second task', 'Nested task'])
  expect(editor.send.currentMarkdown()).toBe(markdown)
  expect(editor.messages.filter((message) => message.type === 'change')).toEqual([])
})

it('updates the task name after editing its text', () => {
  const editor = mount('- [ ] First **task**')
  editor.root.querySelector('strong')!.append(' updated')
  editor.surface.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
  expect(editor.names()).toEqual(['First task updated'])
})

it('keeps an emptied task control named', () => {
  const editor = mount('- [ ] Remove text')
  editor.root.querySelector('p')!.replaceChildren()
  editor.surface.dispatchEvent(
    new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })
  )
  expect(editor.names()).toEqual(['Task'])
})

it('names a task from its own line rather than its code block', () => {
  const editor = mount('- [ ] Install:\n  ```sh\n  pnpm install\n  ```')
  expect(editor.surface.querySelector('li pre')).not.toBeNull()
  expect(editor.names()).toEqual(['Install:'])
})
