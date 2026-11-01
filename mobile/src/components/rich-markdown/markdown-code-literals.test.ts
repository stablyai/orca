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
  [
    'fenced entities',
    '```html\n<span>&amp; &#38; &lt;tag&gt;</span>\n```',
    '<span>&amp; &#38; &lt;tag&gt;</span>'
  ],
  ['inline entities', 'Literal `&amp; &#38; &lt;tag&gt;` sample.', '&amp; &#38; &lt;tag&gt;']
])('preserves %s while editing a different paragraph', (_name, codeMarkdown, codeText) => {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const messages: MobileRichMarkdownEditorMessage[] = []
  const editorDocument = createRichMarkdownEditorDocument({
    ...quietRichMarkdownEditorHost(),
    postToHost: (message) => messages.push(message)
  })
  stopDocuments.push(editorDocument.stop)
  const original = `${codeMarkdown}\n\nUnrelated paragraph`
  editorDocument.send.setMarkdown(original, 7)
  const surface = document.getElementById('editor')!
  expect(surface.querySelector('code')?.textContent).toBe(codeText)
  expect(editorDocument.send.currentMarkdown()).toBe(original)

  surface.lastElementChild!.append('!')
  surface.dispatchEvent(
    new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '!' })
  )

  expect(messages.filter((message) => message.type === 'change')).toEqual([
    { type: 'change', generation: 7, markdown: `${original}!` }
  ])
})

it('preserves text after formatting the gap between inline code spans', async () => {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const messages: MobileRichMarkdownEditorMessage[] = []
  const editorDocument = createRichMarkdownEditorDocument({
    ...quietRichMarkdownEditorHost(),
    postToHost: (message) => messages.push(message)
  })
  stopDocuments.push(editorDocument.stop)
  editorDocument.send.setMarkdown('`old` middle `tail`', 7)
  const paragraph = document.querySelector('#editor p')!
  const range = document.createRange()
  range.selectNodeContents(paragraph.childNodes[1])
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)

  await editorDocument.send.runCommand('inlineCode')

  expect(editorDocument.send.currentMarkdown()).toBe('`old middle tail`')
  expect(messages.filter((message) => message.type === 'change')).toEqual([
    { type: 'change', generation: 7, markdown: '`old middle tail`' }
  ])
  editorDocument.send.setMarkdown(editorDocument.send.currentMarkdown(), 8)
  expect(document.querySelector('#editor code')?.textContent).toBe('old middle tail')
})

it.each([
  ['<code>a`</code><code>``b</code>', '````a```b````', 'a```b'],
  ['<code> left</code><code>right </code>', '`  leftright  `', ' leftright ']
])('preserves adjacent literal code through save and reopen: %s', (html, markdown, text) => {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const editorDocument = createRichMarkdownEditorDocument(quietRichMarkdownEditorHost())
  stopDocuments.push(editorDocument.stop)
  const surface = document.getElementById('editor')!
  surface.innerHTML = `<p>${html}</p>`

  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
  editorDocument.send.setMarkdown(markdown, 8)
  expect(surface.querySelector('code')?.textContent).toBe(text)
  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
})

it.each([
  ['heading', '<h2><code>a</code><code>b</code><pre>x</pre></h2>', '## `ab`\n\n```\nx\n```'],
  ['paragraph', '<p><code>a</code><code>b</code><pre>x</pre></p>', '`ab`\n\n```\nx\n```']
])('joins adjacent inline code beside a %s-owned code block', (_name, html, markdown) => {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const editorDocument = createRichMarkdownEditorDocument(quietRichMarkdownEditorHost())
  stopDocuments.push(editorDocument.stop)
  document.getElementById('editor')!.innerHTML = html

  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
})

it.each([
  ['inline code', '<p><code>x\u00a0 z\u00a0</code> after</p>', '`x  z ` after'],
  ['an inline code line break', '<p><code>first<br>second</code></p>', '`first second`'],
  ['a code block', '<pre><code>\u00a0 \u00a0if x:</code></pre>', '```\n   if x:\n```']
])('saves browser-created spacing in %s as ordinary spaces', (_name, html, markdown) => {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const editorDocument = createRichMarkdownEditorDocument(quietRichMarkdownEditorHost())
  stopDocuments.push(editorDocument.stop)
  document.getElementById('editor')!.innerHTML = html

  expect(editorDocument.send.currentMarkdown()).toBe(markdown)
})
