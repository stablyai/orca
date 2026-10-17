import { describe, expect, it } from 'vitest'
import { svgPreviewDocument } from './mobile-file-svg-preview-document'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'

describe('svgPreviewDocument', () => {
  it('embeds the source as an image data URI rather than inline markup', () => {
    const page = svgPreviewDocument(SVG)
    expect(page).toContain(`src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}"`)
    // Inline markup would run the file's script; inside <img> it cannot.
    expect(page).not.toContain('<svg')
    expect(page).not.toContain('<script>')
  })

  it('cannot break out of the src attribute', () => {
    const page = svgPreviewDocument('"><script>alert(1)</script>')
    expect(page.match(/<img /g)).toHaveLength(1)
    expect(page).not.toContain('"><script>')
  })

  it('fits the image to the phone viewport', () => {
    expect(svgPreviewDocument(SVG)).toContain('name="viewport"')
  })
})
