import { describe, expect, it } from 'vitest'
import { isMobileMermaidLanguage } from './mobile-mermaid-language'
import { normalizeMobileMarkdownPreviewHtml } from './mobile-markdown-preview-html'
import { parseMobileMarkdown } from './mobile-markdown-parser'

describe('isMobileMermaidLanguage', () => {
  it('matches mermaid case-insensitively after trim', () => {
    expect(isMobileMermaidLanguage('mermaid')).toBe(true)
    expect(isMobileMermaidLanguage('Mermaid')).toBe(true)
    expect(isMobileMermaidLanguage(' MERMAID ')).toBe(true)
  })

  it('rejects non-mermaid languages and missing language', () => {
    expect(isMobileMermaidLanguage(undefined)).toBe(false)
    expect(isMobileMermaidLanguage('')).toBe(false)
    expect(isMobileMermaidLanguage('ts')).toBe(false)
    expect(isMobileMermaidLanguage('mermaidx')).toBe(false)
  })
})

describe('parseMobileMarkdown', () => {
  it('parses mermaid fences as code blocks with language mermaid', () => {
    expect(parseMobileMarkdown('```mermaid\ngraph TD; A-->B\n```')).toEqual([
      { type: 'code', text: 'graph TD; A-->B', language: 'mermaid', closed: true }
    ])
    expect(isMobileMermaidLanguage('mermaid')).toBe(true)
  })

  it('marks an unterminated fence as not closed while it streams', () => {
    expect(parseMobileMarkdown('```mermaid\ngraph TD; A-->B')).toEqual([
      { type: 'code', text: 'graph TD; A-->B', language: 'mermaid', closed: false }
    ])
    expect(parseMobileMarkdown('```mermaid\ngraph TD; A-->B\n```')[0]).toMatchObject({
      closed: true
    })
  })

  it('parses GFM tables into table blocks', () => {
    expect(parseMobileMarkdown('| Name | State |\n| --- | --- |\n| Orca | Open |')).toEqual([
      {
        type: 'table',
        headers: ['Name', 'State'],
        rows: [['Orca', 'Open']]
      }
    ])
  })

  it('parses standalone HTTPS images without folding them into paragraphs', () => {
    expect(parseMobileMarkdown('![Screenshot](https://example.com/screen.png)')).toEqual([
      {
        type: 'image',
        alt: 'Screenshot',
        url: 'https://example.com/screen.png'
      }
    ])
  })

  it('normalizes common README HTML into readable Markdown preview text', () => {
    const normalized = normalizeMobileMarkdownPreviewHtml(`
<h1 align="center">
  <a href="https://onOrca.dev"><img src="resources/build/icon.png" alt="Orca" width="64" /></a>
  Orca
</h1>

<p align="center">
  <a href="https://github.com/stablyai/orca/stargazers"><img src="https://badgen.net/github/stars/stablyai/orca" alt="GitHub stars" /></a>
  <strong>The AI Orchestrator</strong><br/>
  Run Codex side-by-side.
</p>
`)

    expect(normalized).toContain('# [Orca](https://onOrca.dev)')
    expect(normalized).toContain('[GitHub stars](https://github.com/stablyai/orca/stargazers)')
    expect(normalized).toContain('**The AI Orchestrator**')
    expect(normalized).not.toContain('<h1')
    expect(normalized).not.toContain('<img')
  })

  it('preserves documented HTML entities while normalizing preview HTML', () => {
    expect(
      normalizeMobileMarkdownPreviewHtml('<p>Use <code>&amp;lt;button&amp;gt;</code></p>')
    ).toBe('Use `&lt;button&gt;`')
  })

  it('preserves angle brackets and generics inside fenced and inline code', () => {
    expect(normalizeMobileMarkdownPreviewHtml('```html\n<div>x</div>\n```')).toBe(
      '```html\n<div>x</div>\n```'
    )
    expect(normalizeMobileMarkdownPreviewHtml('```ts\nconst x: Array<string> = []\n```')).toBe(
      '```ts\nconst x: Array<string> = []\n```'
    )
    expect(normalizeMobileMarkdownPreviewHtml('```ts\nconst x: Array<string> = []')).toBe(
      '```ts\nconst x: Array<string> = []'
    )
    expect(normalizeMobileMarkdownPreviewHtml('Use `Array<string>` here')).toBe(
      'Use `Array<string>` here'
    )
  })

  it('preserves non-tag angle bracket prose while stripping known HTML tags', () => {
    expect(normalizeMobileMarkdownPreviewHtml('1 < 2 and 3 > 1')).toBe('1 < 2 and 3 > 1')
    expect(normalizeMobileMarkdownPreviewHtml('Array<string> in prose')).toBe(
      'Array<string> in prose'
    )
    expect(normalizeMobileMarkdownPreviewHtml('Promise<Result> in prose')).toBe(
      'Promise<Result> in prose'
    )
    expect(normalizeMobileMarkdownPreviewHtml('Promise<Array<string>> in prose')).toBe(
      'Promise<Array<string>> in prose'
    )
    expect(normalizeMobileMarkdownPreviewHtml('Map<string, Array<number>> in prose')).toBe(
      'Map<string, Array<number>> in prose'
    )
    expect(normalizeMobileMarkdownPreviewHtml('type Box<T = string> = { value: T }')).toBe(
      'type Box<T = string> = { value: T }'
    )
    expect(
      normalizeMobileMarkdownPreviewHtml(
        'type Box<T extends object, Value = string> = { value: Value }'
      )
    ).toBe('type Box<T extends object, Value = string> = { value: Value }')
    expect(normalizeMobileMarkdownPreviewHtml('a<b=c>')).toBe('a<b=c>')
    expect(normalizeMobileMarkdownPreviewHtml('<T> is a type parameter')).toBe(
      '<T> is a type parameter'
    )
    expect(normalizeMobileMarkdownPreviewHtml('<mailto:orca@example.com>')).toBe(
      '<mailto:orca@example.com>'
    )
    expect(normalizeMobileMarkdownPreviewHtml('<ftp://example.com/file>')).toBe(
      '<ftp://example.com/file>'
    )
    expect(normalizeMobileMarkdownPreviewHtml('<tel:+15551234567>')).toBe('<tel:+15551234567>')
    expect(normalizeMobileMarkdownPreviewHtml('<https://example.com>')).toBe(
      '<https://example.com>'
    )
    expect(
      normalizeMobileMarkdownPreviewHtml(
        "<https://en.wikipedia.org/wiki/O'Brien> <svg>hidden</svg>"
      )
    ).toBe("<https://en.wikipedia.org/wiki/O'Brien> hidden")
    expect(normalizeMobileMarkdownPreviewHtml('Replace <your-api-key> now')).toBe(
      'Replace <your-api-key> now'
    )
    expect(
      normalizeMobileMarkdownPreviewHtml(
        '<span title="</your-api-key>"></span> Replace <your-api-key> now'
      )
    ).toBe('Replace <your-api-key> now')
    expect(
      normalizeMobileMarkdownPreviewHtml('<span title="</string>"></span> Array<string> now')
    ).toBe('Array<string> now')
    expect(
      normalizeMobileMarkdownPreviewHtml(
        '<span title=</your-api-key>></span> Replace <your-api-key> now'
      )
    ).toBe('Replace <your-api-key> now')
    expect(
      normalizeMobileMarkdownPreviewHtml('<span title=</string>></span> Array<string> now')
    ).toBe('Array<string> now')
    expect(normalizeMobileMarkdownPreviewHtml('Use <insert name here> next')).toBe(
      'Use <insert name here> next'
    )
    expect(normalizeMobileMarkdownPreviewHtml('<div>Readable text</div>')).toBe('Readable text')
  })

  it('preserves angle brackets inside Markdown code produced from HTML code tags', () => {
    expect(normalizeMobileMarkdownPreviewHtml('<p>Use <code>Array&lt;string&gt;</code></p>')).toBe(
      'Use `Array<string>`'
    )
    expect(
      normalizeMobileMarkdownPreviewHtml('<p>Use <code>&lt;div&gt;x&lt;/div&gt;</code></p>')
    ).toBe('Use `<div>x</div>`')
  })

  it('does not replace literal code placeholder text in markdown prose', () => {
    const literalPlaceholder = '\uE000ORCA_MD_CODE_0\uE000'
    expect(normalizeMobileMarkdownPreviewHtml(`${literalPlaceholder} and \`Array<string>\``)).toBe(
      `${literalPlaceholder} and \`Array<string>\``
    )
  })

  it('strips nested HTML and SVG markup without leaking tag variants', () => {
    expect(
      normalizeMobileMarkdownPreviewHtml(
        '<p>Logo<svg viewBox="0 0 1 1"><g><path d="M0 > 0"/></g></svg> done</p>'
      )
    ).toBe('Logo done')
    expect(normalizeMobileMarkdownPreviewHtml('Logo<svg/onload=alert(1)><path/></svg> done')).toBe(
      'Logo done'
    )
    expect(normalizeMobileMarkdownPreviewHtml('Logo<svg=invalid><path/></svg> done')).toBe(
      'Logo done'
    )
    expect(normalizeMobileMarkdownPreviewHtml('Logo<svg=invalid>Hi')).toBe('LogoHi')
    expect(normalizeMobileMarkdownPreviewHtml('Logo<SVG=invalid>Hi')).toBe('LogoHi')
    expect(normalizeMobileMarkdownPreviewHtml('Logo<path=invalid>Hi')).toBe('LogoHi')
    expect(normalizeMobileMarkdownPreviewHtml('Logo<p=invalid>Hi')).toBe('LogoHi')
    expect(normalizeMobileMarkdownPreviewHtml('Logo<strong=invalid>Hi')).toBe('LogoHi')
    expect(normalizeMobileMarkdownPreviewHtml('Logo<math=invalid>Hi')).toBe('LogoHi')
    expect(normalizeMobileMarkdownPreviewHtml('Logo<foo=invalid>Hi')).toBe('LogoHi')
    expect(normalizeMobileMarkdownPreviewHtml('Logo<my-widget=invalid>Hi')).toBe('LogoHi')
    expect(normalizeMobileMarkdownPreviewHtml('Logo<my-widget disabled>Hi')).toBe('LogoHi')
    expect(normalizeMobileMarkdownPreviewHtml('<svg=invalid><path/>')).toBe('')
    expect(normalizeMobileMarkdownPreviewHtml('Logo<my-widget=invalid>Hi</my-widget> done')).toBe(
      'LogoHi done'
    )
    expect(normalizeMobileMarkdownPreviewHtml('<SVG><PATH/></SVG>')).toBe('')
    expect(normalizeMobileMarkdownPreviewHtml('Logo<svg>Hi<path>there')).toBe('LogoHithere')
    expect(normalizeMobileMarkdownPreviewHtml('Logo<p>Hi')).toBe('LogoHi')
    expect(normalizeMobileMarkdownPreviewHtml('Logo<B>Hi')).toBe('LogoHi')
    expect(normalizeMobileMarkdownPreviewHtml('Logo<strong>Hi')).toBe('LogoHi')
    expect(normalizeMobileMarkdownPreviewHtml('Logo<center>Hi <font>there <marquee>now')).toBe(
      'LogoHi there now'
    )
    expect(normalizeMobileMarkdownPreviewHtml('<center>Title</center>')).toBe('Title')
    expect(normalizeMobileMarkdownPreviewHtml('<my-widget>Hi</my-widget>')).toBe('Hi')
    expect(normalizeMobileMarkdownPreviewHtml('<my:widget>')).toBe('')
    expect(normalizeMobileMarkdownPreviewHtml('<svg:path>')).toBe('')
    expect(normalizeMobileMarkdownPreviewHtml('Logo<foo>Hi</foo> done')).toBe('LogoHi done')
    expect(normalizeMobileMarkdownPreviewHtml('</1>Logo<svg>Hi</svg> done')).toBe('</1>LogoHi done')
    expect(normalizeMobileMarkdownPreviewHtml('Logo<svg>Hi</svg   > done')).toBe('LogoHi done')
    expect(normalizeMobileMarkdownPreviewHtml('&lt;svg&gt;&lt;path/&gt;&lt;/svg&gt;')).toBe(
      '<svg><path/></svg>'
    )
    expect(normalizeMobileMarkdownPreviewHtml('<p>Use &lt;svg&gt; icons</p>')).toBe(
      'Use <svg> icons'
    )
    expect(normalizeMobileMarkdownPreviewHtml('<p title="a > b">x</p>')).toBe('x')
    expect(normalizeMobileMarkdownPreviewHtml("<p title='a > b'>x</p>")).toBe('x')
    expect(normalizeMobileMarkdownPreviewHtml('<img alt="a > b">')).toBe('a > b')
    expect(
      normalizeMobileMarkdownPreviewHtml('<a title="a > b" href="https://example.com">link</a>')
    ).toBe('[link](https://example.com)')
    expect(
      normalizeMobileMarkdownPreviewHtml(
        '<a href="https://example.com">first <a href="https://example.com">second'
      )
    ).toBe('first second')
    expect(
      normalizeMobileMarkdownPreviewHtml(
        '<a-widget href="https://wrong.example">custom</a-widget> <a href="https://example.com">real</a>'
      )
    ).toBe('custom [real](https://example.com)')
    expect(
      normalizeMobileMarkdownPreviewHtml(
        '<a data-href="https://wrong.example" href="https://example.com">real</a>'
      )
    ).toBe('[real](https://example.com)')
    expect(
      normalizeMobileMarkdownPreviewHtml(
        '<a title="see href=https://wrong.example" href="https://example.com">real</a>'
      )
    ).toBe('[real](https://example.com)')
    expect(
      normalizeMobileMarkdownPreviewHtml('<a data-href="https://wrong.example">plain</a>')
    ).toBe('plain')
    expect(normalizeMobileMarkdownPreviewHtml('<img data-alt="wrong" alt="right">')).toBe('right')
    expect(
      normalizeMobileMarkdownPreviewHtml(
        '<a:widget href="https://wrong.example">custom</a:widget> <a href="https://example.com">real</a>'
      )
    ).toBe('custom [real](https://example.com)')
    expect(
      normalizeMobileMarkdownPreviewHtml(
        '<a=invalid href="https://wrong.example">bad <a href="https://example.com">real</a>'
      )
    ).toBe('bad [real](https://example.com)')
    expect(
      normalizeMobileMarkdownPreviewHtml(
        '<a href="https://wrong.example"/>bad <a href="https://example.com">real</a>'
      )
    ).toBe('bad [real](https://example.com)')
    expect(
      normalizeMobileMarkdownPreviewHtml(
        '<a href="https://wrong.example">bad <a href="https://example.com">real</a>'
      )
    ).toBe('bad [real](https://example.com)')
    expect(
      normalizeMobileMarkdownPreviewHtml(
        'before<p title="unterminated>middle<svg><path/></svg>after'
      )
    ).toBe('beforemiddleafter')
    expect(normalizeMobileMarkdownPreviewHtml('before<p title=x<svg><path/></svg>after')).toBe(
      'beforeafter'
    )
    expect(normalizeMobileMarkdownPreviewHtml('<p>first</p><p>second')).toBe('first\nsecond')
    expect(normalizeMobileMarkdownPreviewHtml('<strong>first</strong><strong>second')).toBe(
      '**first**second'
    )
    expect(
      normalizeMobileMarkdownPreviewHtml(
        '<strong-widget>custom</strong-widget> <strong>real</strong>'
      )
    ).toBe('custom **real**')
    expect(
      normalizeMobileMarkdownPreviewHtml('Logo<strong=invalid>Hi <strong>real</strong> done')
    ).toBe('LogoHi **real** done')
    expect(normalizeMobileMarkdownPreviewHtml('Logo<strong />Hi <strong>real</strong> done')).toBe(
      'LogoHi **real** done'
    )
    expect(normalizeMobileMarkdownPreviewHtml('<strong>bad <strong>real</strong> done')).toBe(
      'bad **real** done'
    )
    expect(normalizeMobileMarkdownPreviewHtml(`${'<p>x'.repeat(4096)}</p>`)).toBe(
      `${'x'.repeat(4095)}\nx`
    )
  })
})
