// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_MARKDOWN_EDIT_MAX_BYTES } from '../../../../src/shared/mobile-markdown-document'
import { createRichMarkdownEditorDocument } from './create-rich-markdown-editor-document'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import { codeFenceFor } from './markdown-code-fence'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

function originalFence(code: string): string {
  const longest = (code.match(/`+/g) ?? []).reduce((run, match) => Math.max(run, match.length), 0)
  return '`'.repeat(Math.max(3, longest + 1))
}

describe('code-block fence sizing', () => {
  it.each([
    { code: '', length: 3 },
    { code: 'no backticks 😀\uD800\uDC00\u0000', length: 3 },
    { code: '`a`\n``b``', length: 3 },
    { code: 'before```after', length: 4 },
    { code: '````\n``\r\n```', length: 5 },
    { code: '\uD800````\uDC00`````😀', length: 6 },
    { code: '`'.repeat(8192), length: 8193 }
  ])('chooses a fence of $length characters for the whole code block', ({ code, length }) => {
    expect(codeFenceFor(code)).toBe('`'.repeat(length))
  })

  it('matches the previous result across raw UTF-16 text and consecutive calls', () => {
    let seed = 0x823517
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed
    }
    const atoms = ['`', '`', '````', 'a', '\n', '\r', '\u0000', '\uD800', '\uDC00', '😀', 'é', ' ']
    for (let sample = 0; sample < 3000; sample += 1) {
      let code = ''
      const length = random() % 500
      for (let index = 0; index < length; index += 1) {
        code += atoms[random() % atoms.length]
      }
      expect(codeFenceFor(code)).toBe(originalFence(code))
    }
  })

  it('serializes an admitted editable document without collecting every backtick run', () => {
    document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
    const posted: MobileRichMarkdownEditorMessage[] = []
    const editorDocument = createRichMarkdownEditorDocument({
      postToHost: (message) => posted.push(message),
      keyboardInsetSource: () => null
    })
    try {
      const code = '`a'.repeat((MOBILE_MARKDOWN_EDIT_MAX_BYTES - 40) / 2)
      const markdown = `\`\`\`ts\n${code}\n\`\`\``
      expect(markdown.length).toBeLessThan(MOBILE_MARKDOWN_EDIT_MAX_BYTES)
      editorDocument.send.setMarkdown(markdown, 7)
      editorDocument.send.setEditable(true)
      const editor = document.getElementById('editor')
      const codeElement = editor?.querySelector('code')
      if (!editor || !codeElement) {
        throw new Error('The loaded Markdown document has no code block')
      }
      codeElement.textContent = code + 'a'
      posted.length = 0

      const match = String.prototype.match
      let largestMatchArray = 0
      vi.spyOn(String.prototype, 'match').mockImplementation(function (this: string, pattern) {
        const matches = match.call(this, pattern)
        if (matches) {
          largestMatchArray = Math.max(largestMatchArray, matches.length)
        }
        return matches
      })
      editor.dispatchEvent(new Event('input'))

      const expected = `\`\`\`ts\n${code}a\n\`\`\``
      expect(expected.length).toBeLessThan(MOBILE_MARKDOWN_EDIT_MAX_BYTES)
      expect(posted).toEqual([{ type: 'change', markdown: expected, generation: 7 }])
      expect(largestMatchArray).toBeLessThan(1024)
    } finally {
      editorDocument.stop()
    }
  })
})
