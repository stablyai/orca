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
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const messages: MobileRichMarkdownEditorMessage[] = []
  const editor = createRichMarkdownEditorDocument({
    ...quietRichMarkdownEditorHost(),
    postToHost: (message) => messages.push(message)
  })
  stopDocuments.push(editor.stop)
  editor.send.setMarkdown(markdown, 7)
  const surface = document.getElementById('editor')!
  const checks = () =>
    Array.from(surface.querySelectorAll<HTMLInputElement>('input')).map((input) => input.checked)
  return { surface, messages, send: editor.send, checks }
}

it.each([
  ['- [ ]', '- [ ]', [false]],
  ['- [x]', '- [x]', [true]],
  ['- [ ]   ', '- [ ]', [false]],
  ['- [ ] Parent\n  - [x]', '- [ ] Parent\n  - [x]', [false, true]]
])(
  'reloads the empty task in %j without turning its marker into prose',
  (source, saved, checks) => {
    const editor = mount(source)
    expect(editor.checks()).toEqual(checks)
    expect(editor.send.currentMarkdown()).toBe(saved)
    expect(editor.messages.filter((message) => message.type === 'change')).toEqual([])
  }
)

it('saves a toggled empty task as a task marker', () => {
  const editor = mount('- [x]\n- [ ] Next')
  editor.surface.querySelector<HTMLInputElement>('input')!.click()
  expect(editor.messages.filter((message) => message.type === 'change')).toEqual([
    { type: 'change', generation: 7, markdown: '- [ ]\n- [ ] Next' }
  ])
})

it('keeps incomplete task markers and bracket-prefixed text as ordinary list text', () => {
  const markdown = '- [ ]suffix\n- [x]suffix\n- []\n- [z]'
  const editor = mount(markdown)
  expect(editor.checks()).toEqual([])
  expect(editor.send.currentMarkdown()).toBe(markdown)
})
