import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './render-markdown'

// Build the SGR-stripping regex without a literal control char (lint: no-control-regex).
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const strip = (s: string): string => s.replace(SGR, '')

describe('renderMarkdown', () => {
  it('keeps one output line per source line', () => {
    expect(renderMarkdown('a\nb\nc')).toHaveLength(3)
  })

  it('styles headings and strips the # markers', () => {
    const [h1] = renderMarkdown('# Title')
    expect(h1).toContain('\x1b[1m')
    expect(strip(h1)).toBe('Title')
  })

  it('turns list items into bullets and renders inline emphasis', () => {
    const [li] = renderMarkdown('- a **bold** item')
    expect(strip(li)).toBe('• a bold item')
    expect(li).toContain('\x1b[1m')
  })

  it('renders inline code and links to their visible text', () => {
    expect(strip(renderMarkdown('use `npm` now')[0])).toBe('use  npm  now')
    expect(strip(renderMarkdown('see [docs](http://x)')[0])).toBe('see docs')
  })

  it('passes fenced code through verbatim (no inline parsing)', () => {
    const lines = renderMarkdown('```\n- not a bullet\n```')
    expect(strip(lines[1])).toBe('- not a bullet')
  })
})
