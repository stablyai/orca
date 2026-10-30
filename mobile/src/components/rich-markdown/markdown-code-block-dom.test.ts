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

it.each([
  ['first<br>second', 'first\nsecond'],
  ['<code>first</code><br><br><code>second</code>', 'first\n\nsecond'],
  ['prefix <code>middle</code> suffix', 'prefix middle suffix'],
  ['<code>last line</code><br><br>', 'last line']
])('saves native code-block markup %j through input and reload', (html, literal) => {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const messages: MobileRichMarkdownEditorMessage[] = []
  const editor = createRichMarkdownEditorDocument({
    ...quietRichMarkdownEditorHost(),
    postToHost: (message) => messages.push(message)
  })
  stopDocuments.push(editor.stop)
  editor.send.setMarkdown('```ts\nplaceholder\n```', 7)
  const surface = document.getElementById('editor')!
  surface.querySelector('pre')!.innerHTML = html
  surface.dispatchEvent(new Event('input', { bubbles: true }))
  const saved = `\`\`\`ts\n${literal}\n\`\`\``
  expect(messages.filter((message) => message.type === 'change')).toEqual([
    { type: 'change', generation: 7, markdown: saved }
  ])
  editor.send.setMarkdown(saved, 8)
  expect(surface.querySelector('pre code')?.textContent).toBe(literal)
  expect(editor.send.currentMarkdown()).toBe(saved)
})
