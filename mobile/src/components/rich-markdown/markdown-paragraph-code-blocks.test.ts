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

function codeBlock(text: string, language = '') {
  const pre = document.createElement('pre')
  pre.setAttribute('data-language', language)
  pre.append(text)
  return pre
}

function expectRoundTrip(wrapper: Element, markdown: string, codes: string[]) {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const messages: MobileRichMarkdownEditorMessage[] = []
  const editorDocument = createRichMarkdownEditorDocument({
    ...quietRichMarkdownEditorHost(),
    postToHost: (message) => messages.push(message)
  })
  stopDocuments.push(editorDocument.stop)
  editorDocument.send.setMarkdown('seed', 7)
  const editor = document.getElementById('editor')
  if (!editor) {
    throw new Error('Missing editor')
  }
  const outside = document.createElement('p')
  outside.append('Outside')
  editor.replaceChildren(wrapper, outside)
  const live = editor.innerHTML
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))

  expect(editor.innerHTML).toBe(live)
  expect(messages.filter((message) => message.type === 'change')).toEqual([
    { type: 'change', generation: 7, markdown: `${markdown}\n\nOutside` }
  ])
  editorDocument.send.setMarkdown(`${markdown}\n\nOutside`, 8)
  expect(Array.from(editor.querySelectorAll('pre')).map((pre) => pre.textContent)).toEqual(codes)
  expect(editorDocument.send.currentMarkdown()).toBe(`${markdown}\n\nOutside`)
  return editor
}

it('retains native first-line PRE and trailing soft-line text without mutating the live paragraph', () => {
  const paragraph = document.createElement('p')
  paragraph.append(codeBlock('First'), 'Second', document.createElement('br'), 'Third')

  expectRoundTrip(paragraph, '```\nFirst\n```\n\nSecond\nThird', ['First'])
})

it('retains literal code and surrounding marked prose through transparent paragraph wrappers', () => {
  const wrapper = document.createElement('div')
  const before = document.createElement('p')
  before.innerHTML = '<strong>Before</strong>'
  const inner = document.createElement('div')
  const pre = document.createElement('pre')
  pre.setAttribute('data-language', 'ts')
  const code = document.createElement('code')
  code.append('  one\u00a0&amp;\n```')
  pre.append(code, document.createElement('br'), 'Tail')
  inner.append(pre)
  const after = document.createElement('p')
  after.innerHTML = '<em>After</em>'
  wrapper.append(before, inner, after)

  expectRoundTrip(wrapper, '**Before**\n\n````ts\n  one &amp;\n```\nTail\n````\n\n*After*', [
    '  one &amp;\n```\nTail'
  ])
})

it('keeps empty and multiple code blocks separate from intervening prose', () => {
  const wrapper = document.createElement('div')
  const paragraph = document.createElement('p')
  paragraph.append(codeBlock(''), 'Between', codeBlock('const x = 1', 'js'))
  wrapper.append(paragraph)

  expectRoundTrip(wrapper, '```\n\n```\n\nBetween\n\n```js\nconst x = 1\n```', ['', 'const x = 1'])
})

it('keeps unowned list blocks alongside wrapped PRE without changing list ownership', () => {
  const wrapper = document.createElement('div')
  const before = document.createElement('p')
  before.append('Before')
  const list = document.createElement('ul')
  list.innerHTML = '<li><p>Item</p></li>'
  const after = document.createElement('p')
  after.append('After')
  wrapper.append(before, codeBlock('First'), list, after)

  const editor = expectRoundTrip(wrapper, 'Before\n\n```\nFirst\n```\n\n- Item\n\nAfter', ['First'])
  expect(editor.querySelector('pre')?.closest('li')).toBe(null)
  expect(editor.querySelectorAll('li').length).toBe(1)
})
