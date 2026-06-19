import { describe, expect, it, vi } from 'vitest'
import type { GlpiServer } from '../../shared/types'

const glpiServerRequestBinary = vi.fn()

vi.mock('./session', () => ({
  glpiServerRequestBinary: (...args: unknown[]) => glpiServerRequestBinary(...args)
}))

const { inlineGlpiContentImages } = await import('./glpi-content-images')

const server: GlpiServer = {
  id: 'srv-1',
  baseUrl: 'https://glpi.example.com',
  apiBaseUrl: 'https://glpi.example.com/apirest.php',
  displayName: 'glpi.example.com',
  account: 'me'
}

// Minimal valid PNG header so mime sniffing succeeds even without a content-type.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

describe('inlineGlpiContentImages', () => {
  it('returns content unchanged when there are no document references', async () => {
    glpiServerRequestBinary.mockReset()
    const html = '<p>Just text, no image.</p>'
    await expect(inlineGlpiContentImages(server, html)).resolves.toBe(html)
    expect(glpiServerRequestBinary).not.toHaveBeenCalled()
  })

  it('inlines an image document as a data URI and absolutizes the link', async () => {
    glpiServerRequestBinary.mockReset()
    glpiServerRequestBinary.mockResolvedValue({ data: PNG_BYTES, contentType: 'image/png' })
    const html =
      '<p><a href="/front/document.send.php?docid=155&amp;itemtype=Ticket&amp;items_id=2" target="_blank">' +
      '<img alt="x" width="1920" src="/front/document.send.php?docid=155&amp;itemtype=Ticket&amp;items_id=2" /></a></p>'

    const result = await inlineGlpiContentImages(server, html)

    expect(glpiServerRequestBinary).toHaveBeenCalledWith(server, '/Document/155')
    expect(result).toContain(`src="data:image/png;base64,${PNG_BYTES.toString('base64')}"`)
    // The wrapping link is absolutized to the GLPI server (never the app origin).
    expect(result).toContain(
      'href="https://glpi.example.com/front/document.send.php?docid=155&amp;itemtype=Ticket&amp;items_id=2"'
    )
    expect(result).not.toContain('src="/front/document.send.php')
  })

  it('absolutizes the image link when the document cannot be inlined', async () => {
    glpiServerRequestBinary.mockReset()
    glpiServerRequestBinary.mockResolvedValue(null)
    const html =
      '<img src="/front/document.send.php?docid=900&amp;itemtype=Ticket&amp;items_id=2" />'

    const result = await inlineGlpiContentImages(server, html)

    expect(result).toContain(
      'src="https://glpi.example.com/front/document.send.php?docid=900&amp;itemtype=Ticket&amp;items_id=2"'
    )
    expect(result).not.toContain('data:image')
  })
})
