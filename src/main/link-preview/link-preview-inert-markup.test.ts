import { expect, it } from 'vitest'
import { decodeHtmlBody, readLinkPreviewMetadata } from './link-preview-page-metadata'
import { extractHtmlTitle } from '../network/page-metadata/html-head-tags'

it('ignores metadata examples inside comments, raw text and other tags attributes', () => {
  const html = `<!-- <meta charset="windows-1252"><meta property="og:title" content="Removed">
    <title>Removed tab title</title><link rel="icon" href="/removed.ico"> --!><!--><!--->
    <!example <meta property="og:title" content="Declaration example">>
    <script>const example = '<meta name="description" content="Script example">';</script>
    <script><!--
      const nested = '<script></script><meta property="og:site_name" content="Double escaped example">';
    --></script>
    <style>body::before { content: '<meta property="og:site_name" content="Style example">'; }</style>
    <div data-example='<meta property="og:image" content="/example.png">'></div>
    <x-card.foo data-example='<meta property="og:title" content="Dot tag example">'></x-card.foo>
    <x-card_foo data-example='<meta property="og:site_name" content="Underscore tag example">'></x-card_foo>
    </div data-example='<meta name="description" content="End tag example">'>
    <title-widget>Custom element</title-widget><link-custom rel="icon" href="/custom.ico">
    <meta charset="utf-8"><title data-note=">">Café &amp; tools</title>
    <div data-x=a="><meta name="description" content="Actual description"><link rel="icon" href="/actual.ico">`
  const decoded = decodeHtmlBody(Buffer.from(html), 'text/html')
  expect(extractHtmlTitle(decoded)).toBe('Café & tools')
  expect(readLinkPreviewMetadata(decoded, new URL('https://example.test/'))).toEqual({
    title: 'Café & tools',
    description: 'Actual description',
    siteName: null,
    imageUrl: null,
    iconHref: '/actual.ico'
  })
})
