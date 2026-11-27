import { expect, it } from 'vitest'
import { decodeHtmlBody } from './link-preview-page-metadata'

it('decodes a BOM before a conflicting HTTP charset for link previews', () => {
  const html = '<title>雪</title>'
  const contentType = 'text/html; charset=windows-1252'
  expect(decodeHtmlBody(Buffer.from(`\ufeff${html}`), contentType)).toBe('<title>雪</title>')
  expect(
    decodeHtmlBody(
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(html, 'utf16le')]),
      contentType
    )
  ).toBe('<title>雪</title>')
  expect(
    decodeHtmlBody(
      Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(html, 'utf16le').swap16()]),
      contentType
    )
  ).toBe('<title>雪</title>')
})
