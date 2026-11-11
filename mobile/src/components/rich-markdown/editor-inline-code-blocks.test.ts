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

function mount(markdown: string) {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const messages: MobileRichMarkdownEditorMessage[] = []
  const editorDocument = createRichMarkdownEditorDocument({
    ...quietRichMarkdownEditorHost(),
    postToHost: (message) => messages.push(message)
  })
  stopDocuments.push(editorDocument.stop)
  editorDocument.send.setMarkdown(markdown, 7)
  const surface = document.getElementById('editor')!
  return { surface, messages, send: editorDocument.send }
}

function select(range: Range) {
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

it.each([
  ['first\n\nsecond\n\nthird', '`first`\n\n`second`\n\n`third`', ['first', 'second', 'third']],
  ['# Heading\n\n> Quoted', '# `Heading`\n\n> `Quoted`', ['Heading', 'Quoted']],
  ['- first\n- second', '- `first`\n- `second`', ['first', 'second']],
  ['- [ ] first\n- [x] second', '- [ ] `first`\n- [x] `second`', ['first', 'second']],
  [
    'left ![pixel](https://example.com/pixel.png) right',
    '`left `![pixel](https://example.com/pixel.png)` right`',
    ['left ', ' right']
  ],
  ['left\nright', '`left`\n`right`', ['left', 'right']]
])('keeps blocks and embedded content when formatting %j', async (markdown, saved, codes) => {
  const editor = mount(markdown)
  const range = document.createRange()
  range.selectNodeContents(editor.surface)
  select(range)
  await editor.send.runCommand('inlineCode')
  expect(
    editor.surface.querySelector(
      'code p,code h1,code blockquote,code ul,code li,code img,code br,code input'
    )
  ).toBeNull()
  expect(
    Array.from(editor.surface.querySelectorAll('code')).map((code) => code.textContent)
  ).toEqual(codes)
  expect(editor.messages.filter((message) => message.type === 'change')).toEqual([
    { type: 'change', generation: 7, markdown: saved }
  ])
  editor.send.setMarkdown(saved, 8)
  expect(
    Array.from(editor.surface.querySelectorAll('code')).map((code) => code.textContent)
  ).toEqual(codes)
  expect(editor.send.currentMarkdown()).toBe(saved)
})

it('keeps unselected paragraph prefixes and suffixes', async () => {
  const editor = mount('Prefix first\n\nMiddle text\n\nlast suffix')
  const paragraphs = editor.surface.querySelectorAll('p')
  const range = document.createRange()
  range.setStart(paragraphs[0].firstChild!, 7)
  range.setEnd(paragraphs[2].firstChild!, 4)
  select(range)
  await editor.send.runCommand('inlineCode')
  expect(editor.surface.querySelectorAll('p')).toHaveLength(3)
  expect(
    Array.from(editor.surface.querySelectorAll('p')).map((paragraph) => paragraph.innerHTML)
  ).toEqual(['Prefix <code>first</code>', '<code>Middle text</code>', '<code>last</code> suffix'])
  expect(editor.send.currentMarkdown()).toBe('Prefix `first`\n\n`Middle text`\n\n`last` suffix')
  expect(window.getSelection()?.toString().replace(/\n/g, '')).toBe('firstMiddle textlast')
})

it('keeps an image nested inside inline formatting', async () => {
  const editor = mount('**left ![pixel](https://example.com/pixel.png) right**')
  const image = editor.surface.querySelector('img')!
  const range = document.createRange()
  range.selectNodeContents(editor.surface)
  select(range)
  await editor.send.runCommand('inlineCode')
  expect(image.isConnected).toBe(true)
  expect(image.closest('code')).toBeNull()
  expect(
    Array.from(editor.surface.querySelectorAll('code')).map((code) => code.textContent)
  ).toEqual(['left ', ' right'])
  expect(editor.send.currentMarkdown()).toContain('![pixel](https://example.com/pixel.png)')
})

it('leaves existing code blocks intact when selecting surrounding paragraphs', async () => {
  const editor = mount('Before\n\n```ts\nconst n = 1\n```\n\nAfter')
  const original = editor.surface.querySelector('pre')!.outerHTML
  const range = document.createRange()
  range.selectNodeContents(editor.surface)
  select(range)
  await editor.send.runCommand('inlineCode')
  expect(editor.surface.querySelector('pre')!.outerHTML).toBe(original)
  expect(editor.send.currentMarkdown()).toBe('`Before`\n\n```ts\nconst n = 1\n```\n\n`After`')
})

it('formats selected spaces within a paragraph', async () => {
  const editor = mount('placeholder')
  const paragraph = editor.surface.querySelector('p')!
  paragraph.textContent = '   '
  const range = document.createRange()
  range.selectNodeContents(paragraph)
  select(range)
  await editor.send.runCommand('inlineCode')
  expect(editor.send.currentMarkdown()).toBe('`   `')
})
