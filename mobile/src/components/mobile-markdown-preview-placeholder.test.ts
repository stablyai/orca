import { describe, expect, it } from 'vitest'
import { normalizeMobileMarkdownPreviewHtml } from './mobile-markdown-preview-html'

const marker = '\uE000ORCA_MD_CODE_'
const suffix = '\uE000'

describe('mobile Markdown code placeholder collisions', () => {
  it.each([0, 1, 2, 15, 128, 16384])('preserves a literal marker with %i underscores', (length) => {
    const literal = `${marker}${'_'.repeat(length)}0${suffix}`
    const input = `${literal} and \`Array<string>\`\n\n\`\`\`html\n<p>literal</p>\n\`\`\``
    expect(normalizeMobileMarkdownPreviewHtml(input)).toBe(input)
  })

  it('handles adjacent markers and repeated maximum suffixes', () => {
    const literal = `${marker}${marker}__0${suffix}${marker}__1${suffix}${marker}_2${suffix}`
    expect(normalizeMobileMarkdownPreviewHtml(`<p>${literal} and \`<div>\`</p>`)).toBe(
      `${literal} and \`<div>\``
    )
  })

  it('preserves authored markers across generated suffix orders and HTML islands', () => {
    let seed = 173
    for (let sample = 0; sample < 500; sample++) {
      const literals: string[] = []
      for (let index = 0; index < 8; index++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        literals.push(`${marker}${'_'.repeat(seed % 32)}${index}${suffix}`)
      }
      const text = literals.join(' ') + ' and `Array<string>`'
      expect(normalizeMobileMarkdownPreviewHtml(`<p>${text}</p>`)).toBe(text)
    }
  })
})
