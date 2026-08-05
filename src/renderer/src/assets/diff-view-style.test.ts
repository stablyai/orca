import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = fs.readFileSync(new URL('./diff-view.css', import.meta.url), 'utf8')
const mainCss = fs.readFileSync(new URL('./main.css', import.meta.url), 'utf8')

describe('diff view styling', () => {
  it('is loaded by the renderer entry stylesheet', () => {
    expect(mainCss).toContain("@import './diff-view.css';")
  })

  // Ratio is free to change; deriving from the theme's own chip color is not.
  it('derives the row wash from the theme chip color instead of a literal', () => {
    expect(css).toMatch(
      /--vscode-diffEditor-insertedLineBackground:\s*color-mix\(\s*in srgb,\s*var\(--vscode-diffEditor-insertedTextBackground\)\s*\d+%,\s*transparent\s*\)/s
    )
    expect(css).toMatch(
      /--vscode-diffEditor-removedLineBackground:\s*color-mix\(\s*in srgb,\s*var\(--vscode-diffEditor-removedTextBackground\)\s*\d+%,\s*transparent\s*\)/s
    )
  })

  it('writes no hex color literal, so the active Monaco theme keeps every hue', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })

  it('suppresses the full-width char decoration that stacks on the row wash', () => {
    expect(css).toMatch(/\.cdr\.char-insert\[style\*='100%'\]/)
    expect(css).toMatch(/\.cdr\.char-delete\[style\*='100%'\]/)
  })

  it('hides the duplicated unified-mode delete sign', () => {
    expect(css).toMatch(
      /\.monaco-diff-editor:not\(\.side-by-side\) \.margin-view-overlays \.delete-sign\s*{[^}]*display:\s*none\s*!important/s
    )
  })

  // `overflow: hidden` here would make the panel a scroll container and drop the
  // sticky file header out of the outer scrollport.
  it('rounds the section panel without breaking its sticky header', () => {
    const panelRule = css.match(/\.diff-section-panel\s*{[^}]*}/s)?.[0] ?? ''
    expect(panelRule).toContain('overflow: clip')
    expect(panelRule).not.toContain('overflow: hidden')
    expect(panelRule).not.toContain('overflow: auto')
  })

  // Scrollport top padding reappears as a gap above the stuck file header.
  it('keeps the scroll container free of top padding', () => {
    const containerRule = (
      css.match(/\.combined-diff-scroll-container\s*{[^}]*}/s)?.[0] ?? ''
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(containerRule).toContain('padding-bottom')
    expect(containerRule).not.toMatch(/\bpadding(-block|-top)?\s*:/)
  })

  it('scopes every Monaco rule under .monaco-diff-editor so plain editors are untouched', () => {
    const selectors = css
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('}')
      .map((block) => block.split('{')[0]?.trim())
      .filter((selector): selector is string => Boolean(selector))
      .flatMap((selector) => selector.split(',').map((part) => part.trim()))
      .filter(Boolean)

    for (const selector of selectors) {
      if (!selector.includes('monaco')) {
        continue
      }
      // A bare `.monaco-editor` root would leak diff styling into plain editors.
      expect(selector.startsWith('.monaco-editor')).toBe(false)
      expect(
        selector.startsWith('.monaco-diff-editor') ||
          selector.startsWith('.combined-diff-scroll-container')
      ).toBe(true)
    }
  })
})
