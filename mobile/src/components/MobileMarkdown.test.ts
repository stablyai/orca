import { describe, expect, it } from 'vitest'
import { normalizeMobileMarkdownPreviewHtml } from './mobile-markdown-preview-html'
import { parseMobileMarkdown } from './mobile-markdown-parser'

describe('parseMobileMarkdown', () => {
  it('parses GFM tables into table blocks', () => {
    expect(parseMobileMarkdown('| Name | State |\n| --- | --- |\n| Orca | Open |')).toEqual([
      {
        type: 'table',
        headers: ['Name', 'State'],
        rows: [['Orca', 'Open']]
      }
    ])
  })

  it('tracks nesting depth for indented list items (4-space convention)', () => {
    const blocks = parseMobileMarkdown('- top\n    - child\n        - grandchild\n- top two')
    expect(blocks).toHaveLength(1)
    const list = blocks[0]
    expect(list?.type).toBe('list')
    if (list?.type !== 'list') {
      throw new Error('expected list')
    }
    expect(list.items.map((i) => ({ text: i.text, depth: i.depth }))).toEqual([
      { text: 'top', depth: 0 },
      { text: 'child', depth: 1 },
      { text: 'grandchild', depth: 2 },
      { text: 'top two', depth: 0 }
    ])
  })

  it('tracks nesting depth with the 2-space convention too', () => {
    const blocks = parseMobileMarkdown('- a\n  - b\n  - c\n- d')
    const list = blocks[0]
    if (list?.type !== 'list') {
      throw new Error('expected list')
    }
    expect(list.items.map((i) => i.depth)).toEqual([0, 1, 1, 0])
  })

  it('keeps flat lists at depth 0', () => {
    const blocks = parseMobileMarkdown('- a\n- b\n- c')
    const list = blocks[0]
    if (list?.type !== 'list') {
      throw new Error('expected list')
    }
    expect(list.items.every((i) => i.depth === 0)).toBe(true)
  })

  it('parses standalone HTTPS images without folding them into paragraphs', () => {
    expect(parseMobileMarkdown('![Screenshot](https://example.com/screen.png)')).toEqual([
      {
        type: 'image',
        alt: 'Screenshot',
        url: 'https://example.com/screen.png'
      }
    ])
  })

  it('normalizes common README HTML into readable Markdown preview text', () => {
    const normalized = normalizeMobileMarkdownPreviewHtml(`
<h1 align="center">
  <a href="https://onOrca.dev"><img src="resources/build/icon.png" alt="Orca" width="64" /></a>
  Orca
</h1>

<p align="center">
  <a href="https://github.com/stablyai/orca/stargazers"><img src="https://badgen.net/github/stars/stablyai/orca" alt="GitHub stars" /></a>
  <strong>The AI Orchestrator</strong><br/>
  Run Codex side-by-side.
</p>
`)

    expect(normalized).toContain('# [Orca](https://onOrca.dev)')
    expect(normalized).toContain('[GitHub stars](https://github.com/stablyai/orca/stargazers)')
    expect(normalized).toContain('**The AI Orchestrator**')
    expect(normalized).not.toContain('<h1')
    expect(normalized).not.toContain('<img')
  })

  it('preserves documented HTML entities while normalizing preview HTML', () => {
    expect(
      normalizeMobileMarkdownPreviewHtml('<p>Use <code>&amp;lt;button&amp;gt;</code></p>')
    ).toBe('Use `&lt;button&gt;`')
  })
})
