// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { createRichMarkdownEditorDocument } from './create-rich-markdown-editor-document'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import { quietRichMarkdownEditorHost } from './rich-markdown-editor-host.test-support'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'

const stopDocuments: (() => void)[] = []

afterEach(() => {
  stopDocuments.splice(0).forEach((stop) => stop())
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
})

function mount() {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const messages: MobileRichMarkdownEditorMessage[] = []
  const editorDocument = createRichMarkdownEditorDocument({
    ...quietRichMarkdownEditorHost(),
    postToHost: (message) => messages.push(message)
  })
  stopDocuments.push(editorDocument.stop)
  const surface = document.getElementById('editor')!
  return { surface, messages, send: editorDocument.send }
}

it.each([
  ['a`b', '``a`b``'],
  ['a``b', '```a``b```'],
  ['`edge', '`` `edge ``'],
  ['edge`', '`` edge` ``'],
  ['`', '`` ` ``'],
  ['  surrounded  ', '`   surrounded   `'],
  ['   ', '`   `']
])('preserves selected inline code %j through the host and a reload', async (literal, saved) => {
  const editor = mount()
  editor.send.setMarkdown('placeholder', 7)
  const paragraph = editor.surface.querySelector('p')!
  paragraph.textContent = literal
  const range = document.createRange()
  range.selectNodeContents(paragraph)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  await editor.send.runCommand('inlineCode')
  expect(editor.surface.querySelector('code')?.textContent).toBe(literal)
  expect(editor.messages.filter((message) => message.type === 'change')).toEqual([
    { type: 'change', generation: 7, markdown: saved }
  ])
  editor.send.setMarkdown(saved, 8)
  expect(editor.surface.querySelector('p')?.textContent).toBe(literal)
  expect(
    Array.from(editor.surface.querySelectorAll('code')).map((code) => code.textContent)
  ).toEqual([literal])
  expect(editor.send.currentMarkdown()).toBe(saved)
})

it('matches whole delimiter runs and leaves unmatched runs as prose', () => {
  const editor = mount()
  const markdown = 'Use ``a```b`` and `plain` and unmatched ``` tail'
  editor.send.setMarkdown(markdown, 1)
  expect(
    Array.from(editor.surface.querySelectorAll('code')).map((code) => code.textContent)
  ).toEqual(['a```b', 'plain'])
  expect(editor.surface.querySelector('p')?.textContent).toBe(
    'Use a```b and plain and unmatched ``` tail'
  )
})
