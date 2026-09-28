import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { normalizeMobileMarkdownPreviewHtml } from './mobile-markdown-preview-html'
import { parseMobileMarkdown } from './mobile-markdown-parser'

function parseWithDeadline(input: string) {
  // A synchronous parser loop must fail without hanging the test worker.
  return runInNewContext('parse(input)', { parse: parseMobileMarkdown, input }, { timeout: 250 })
}

describe('mobile Markdown parser progress', () => {
  it.each(['```c++', '```c#', '``` ts', '```ts title="file.ts"', '````', '```!'])(
    'retains unsupported fence %s as paragraph text',
    (fence) => {
      expect(parseWithDeadline(fence)).toEqual([{ type: 'paragraph', text: fence }])
      expect(parseWithDeadline(`before\n${fence}\nafter`)).toEqual([
        { type: 'paragraph', text: `before\n${fence}\nafter` }
      ])
    }
  )

  it.each(['# ', '## ', '###### ', '#\t'])('consumes incomplete heading %s', (heading) => {
    expect(parseWithDeadline(`${heading}\nnext`)).toEqual([
      { type: 'paragraph', text: `${heading}\nnext` }
    ])
  })

  it('handles unsupported fences through the production preview normalization', () => {
    const input = normalizeMobileMarkdownPreviewHtml('```c++\nint x = 1;')
    expect(parseWithDeadline(input)).toEqual([{ type: 'paragraph', text: input }])
  })

  it('recognizes a supported fence after unsupported fence text', () => {
    expect(parseWithDeadline('```c++\n```ts\nconst x = 1\n```')).toEqual([
      { type: 'paragraph', text: '```c++' },
      { type: 'code', text: 'const x = 1', language: 'ts', closed: true }
    ])
  })

  it('preserves supported fences and their streaming state', () => {
    expect(parseWithDeadline('before\n```ts\nconst x = 1')).toEqual([
      { type: 'paragraph', text: 'before' },
      { type: 'code', text: 'const x = 1', language: 'ts', closed: false }
    ])
  })
})
