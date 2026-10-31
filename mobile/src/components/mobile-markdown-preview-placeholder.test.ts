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
})
