import { expect, it } from 'vitest'
import { decodeHtmlBody, readLinkPreviewMetadata } from './link-preview-page-metadata'

const pageUrl = new URL('https://example.test/page')

it('reads live metadata after comments, script text and quoted tag attributes', () => {
  const html = `<!-- <meta property="og:title" content="Removed"><link rel="icon" href="/removed.ico"> --!><!--><!--->
    <!example <meta property="og:site_name" content="Declaration example">>
    <script><!-- const example = '<script></script><meta name="description" content="Script example">'; --></script>
    <style>body::before { content: '<meta property="og:image" content="/example.png">'; }</style>
    <x-card.foo data-example='> <b> <meta property="og:title" content="Attribute example">'></x-card.foo>
    </div data-example='<meta name="description" content="End tag example">'>
    <div data-x="unclosed <div></div>text = " unclosed text <meta property="og:title" content="Attribute after nested close">
    <title-widget>Custom element</title-widget><link-custom rel="icon" href="/custom.ico">
    <script><!--><script></script><script><!---><script></script>
    <title data-note=">">Café &amp; tools</title>
    <div data-x=a="><meta name="description" content="Actual description"><link rel="icon" href="/actual.ico">`
  expect(readLinkPreviewMetadata(html, pageUrl)).toEqual({
    title: 'Café & tools',
    description: 'Actual description',
    siteName: null,
    imageUrl: null,
    iconHref: '/actual.ico'
  })
})

it('uses a live charset beyond 64 KB instead of an earlier commented declaration', () => {
  const html = `<!-- <meta charset="utf-8"> -->${' '.repeat(70 * 1024)}<meta charset="windows-1252"><title>Café</title>`
  expect(decodeHtmlBody(Buffer.from(html, 'latin1'), 'text/html')).toContain('<title>Café</title>')
})

it('keeps XHTML script boundaries distinct from HTML raw-text scripts', () => {
  const head =
    '<!-- <title>Removed</title> --><script src="/boot.js"/><title>XML title</title>' +
    '<meta name="description" content="XML description"><link rel="icon" href="/xml.ico"/>'
  expect(readLinkPreviewMetadata(head, pageUrl, 'application/xhtml+xml; charset=utf-8')).toEqual({
    title: 'XML title',
    description: 'XML description',
    siteName: null,
    imageUrl: null,
    iconHref: '/xml.ico'
  })
  expect(readLinkPreviewMetadata(`${head}</script><title>HTML title</title>`, pageUrl)).toEqual({
    title: 'HTML title',
    description: null,
    siteName: null,
    imageUrl: null,
    iconHref: '/favicon.ico'
  })
  for (const text of [
    '<![CDATA[const example = "<!-- <script>";]]>',
    '<![CDATA[const example = "<!-- <script></script><title>Hidden</title>";]]>',
    '<!-- <script></script><title>Hidden</title> -->'
  ]) {
    const html =
      `<script>${text}</script>` +
      '<title>XML title</title><meta name="description" content="XML description"/>' +
      '<link rel="icon" href="/xml.ico"/>'
    expect(readLinkPreviewMetadata(html, pageUrl, 'application/xhtml+xml')).toEqual({
      title: 'XML title',
      description: 'XML description',
      siteName: null,
      imageUrl: null,
      iconHref: '/xml.ico'
    })
  }
  for (const opener of ['<![CDATA[', '<!--']) {
    const html = `<script>${opener}</script><title>Still hidden</title>`
    expect(readLinkPreviewMetadata(html, pageUrl, 'application/xhtml+xml').title).toBeNull()
  }
})
