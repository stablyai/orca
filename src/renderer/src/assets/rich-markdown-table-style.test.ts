import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const editorCss = fs.readFileSync(new URL('./rich-markdown-editor.css', import.meta.url), 'utf8')
const mainCss = fs.readFileSync(new URL('./main.css', import.meta.url), 'utf8')

describe('rich Markdown table resize styling', () => {
  it('keeps wide tables inside a local horizontal scroller', () => {
    expect(editorCss).toMatch(
      /\.rich-markdown-editor \.tableWrapper\s*{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*margin:\s*1em 0;[^}]*overflow-x:\s*auto;/s
    )
    expect(editorCss).toMatch(
      /\.rich-markdown-editor table\s*{[^}]*width:\s*100%;[^}]*margin:\s*0;/s
    )
  })

  it('uses the native handle classes and Orca tokens', () => {
    expect(editorCss).toMatch(
      /\.rich-markdown-editor th,\s*\.rich-markdown-editor td\s*{[^}]*position:\s*relative;/s
    )
    expect(editorCss).toMatch(
      /\.rich-markdown-editor \.column-resize-handle\s*{[^}]*width:\s*4px;[^}]*background:\s*var\(--ring\);[^}]*cursor:\s*col-resize;/s
    )
    expect(editorCss).toMatch(
      /\.rich-markdown-editor\.resize-cursor,\s*\.rich-markdown-editor\.resize-cursor \*\s*{[^}]*cursor:\s*col-resize;/s
    )
    expect(editorCss).not.toMatch(/\.column-resize-handle[^}]*#[0-9a-f]{3,8}/i)
  })

  it('keeps horizontal scrollbar sizing scoped to rich Markdown tables', () => {
    expect(mainCss).toMatch(
      /\.scrollbar-editor,\s*\.rich-markdown-editor \.tableWrapper,\s*\.xterm \.xterm-viewport\s*{/s
    )
    const sharedScrollbarRule = mainCss.match(
      /\.scrollbar-editor::-webkit-scrollbar,\s*\.rich-markdown-editor \.tableWrapper::-webkit-scrollbar,\s*\.xterm \.xterm-viewport::-webkit-scrollbar\s*{([^}]*)}/s
    )
    expect(sharedScrollbarRule?.[1]).toContain('width: 14px')
    expect(sharedScrollbarRule?.[1]).not.toContain('height:')
    expect(mainCss).toMatch(
      /\.rich-markdown-editor \.tableWrapper::-webkit-scrollbar\s*{[^}]*height:\s*14px;/s
    )
  })
})
