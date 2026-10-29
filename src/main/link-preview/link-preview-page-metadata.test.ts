import { describe, expect, it } from 'vitest'
import { decodeHtmlBody, readLinkPreviewMetadata } from './link-preview-page-metadata'

const PAGE_URL = new URL('https://docs.example.com/guide/start')

describe('readLinkPreviewMetadata', () => {
  it('prefers Open Graph, then Twitter, then plain tags, and resolves the image', () => {
    const html = `<head>
      <title>Plain title</title>
      <meta name="twitter:title" content="Twitter title">
      <meta property='og:title' content='  Open   Graph &amp; friends '>
      <meta name="description" content="Plain description">
      <meta name="twitter:description" content="Twitter description">
      <meta content="OG site" property="og:site_name">
      <meta name="twitter:image" content="https://cdn.example.com/twitter.png">
      <meta property="og:image" content="../img/card.png?v=1&amp;s=2">
      <link rel="apple-touch-icon" href="/touch.png"><link rel="icon" href="/favicon.svg">
    </head>`

    expect(readLinkPreviewMetadata(html, PAGE_URL)).toEqual({
      title: 'Open Graph & friends',
      description: 'Twitter description',
      siteName: 'OG site',
      imageUrl: 'https://docs.example.com/img/card.png?v=1&s=2',
      iconHref: '/favicon.svg'
    })
  })

  it('keeps a > inside a quoted attribute value as part of the value', () => {
    const html = `<meta content="Home > Docs" property="og:description"><meta property="og:title" content="A > B">`

    expect(readLinkPreviewMetadata(html, PAGE_URL)).toMatchObject({
      title: 'A > B',
      description: 'Home > Docs'
    })
  })

  it('falls back to <title>, the meta description and /favicon.ico, and caps long text', () => {
    const html = `<title>Plain\n title</title><meta name="description" content="${'word '.repeat(200)}">`

    const metadata = readLinkPreviewMetadata(html, PAGE_URL)
    expect(metadata).toMatchObject({
      title: 'Plain title',
      imageUrl: null,
      iconHref: '/favicon.ico'
    })
    expect(metadata.description).toHaveLength(400)
    expect(metadata.description?.endsWith('…')).toBe(true)
  })
})

describe('decodeHtmlBody', () => {
  it('decodes with a <meta charset> when the header names none', () => {
    const body = Buffer.concat([
      Buffer.from('<meta charset="windows-1252"><title>Caf'),
      Buffer.from([0xe9, 0x20, 0x93, 0x6f, 0x6b, 0x94]),
      Buffer.from('</title>')
    ])
    expect(decodeHtmlBody(body, 'text/html')).toContain('Café “ok”')
  })

  it('lets the header charset win and falls back to UTF-8 on unknown labels', () => {
    const shiftJis = Buffer.from([0x93, 0xfa, 0x96, 0x7b])
    expect(decodeHtmlBody(shiftJis, 'text/html; charset="Shift_JIS"')).toBe('日本')
    expect(decodeHtmlBody(Buffer.from('日本'), 'text/html; charset=nonsense')).toBe('日本')
  })
})
