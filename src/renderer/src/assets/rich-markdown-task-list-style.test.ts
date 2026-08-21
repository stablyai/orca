import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const editorCss = fs.readFileSync(new URL('./rich-markdown-editor.css', import.meta.url), 'utf8')

describe('rich markdown task-list styling', () => {
  it('keeps flex layout scoped to direct task items', () => {
    expect(editorCss).toMatch(
      /\.rich-markdown-editor ul\[data-type='taskList'\] > li\s*{[^}]*display:\s*flex/s
    )
    expect(editorCss).not.toMatch(
      /\.rich-markdown-editor ul\[data-type='taskList'\] li\s*{[^}]*display:\s*flex/s
    )
  })
})
