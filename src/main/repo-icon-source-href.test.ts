import { describe, expect, it } from 'vitest'
import { extractIconHref } from './repo-icon-source-href'

// Original production expressions are the compatibility oracle.
const HTML_RE =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i
const OBJECT_RE =
  /(?=[^}]*\brel\s*:\s*["'](?:icon|shortcut icon)["'])(?=[^}]*\bhref\s*:\s*["']([^"'?]+))[^}]*/i

export function originalIconHref(source: string): string | null {
  return source.match(HTML_RE)?.[1] ?? source.match(OBJECT_RE)?.[1] ?? null
}

describe('repo icon source href compatibility', () => {
  it.each([
    '<link <link <link rel="icon" href="last.png">',
    '<link rel="icon" href="first.png" href="last.png">',
    '<link rel="icon" href="cross>angle.png">',
    '<LINK rel="ICON" href="upper.png">',
    '<link href="wrong.png"><link rel="icon" href="right.png">',
    '',
    'plain source without icon properties',
    '{ rel: "icon", href: "/first.png", href: "/last.png" }',
    '{ href: "/first.png", rel: "icon", rel: "stylesheet" }',
    '{ rel: "icon" } { href: "/unrelated.png" }',
    '{ rel: "icon", href: "/first.png" } { rel: "icon", href: "/last.png" }',
    '{ rel: "icon", href: "/object.png" } <link href="/html.png" rel="icon">',
    '{ rel: "ICON", href: "/UPPER.png" }',
    '}\n\n{href: "/line.png",\nrel : "shortcut icon"}',
    '{ rel: "icon", href: "/unterminated}after brace',
    '{ rel: "icon", href: "?query" }',
    '{ rel: "icon", href: "/before?query" }',
    '<link rel="stylesheet" href="/no.png">',
    '<link rel="icon" href="/yes.png"',
    '{rel:"icon",href:"/nested{brace}.png"}',
    'xrel:"icon", xhref:"/no.png"'
  ])('preserves original selection for %s', (source) => {
    expect(extractIconHref(source)).toBe(originalIconHref(source))
  })

  it('matches the original across generated malformed property sequences', () => {
    const tokens = [
      '}',
      '{',
      ' ',
      'rel:"icon"',
      'href:"a"',
      'href:"b"',
      'rel:"other"',
      'x',
      '\n',
      '<link ',
      '>',
      'rel="icon"',
      'href="a"',
      'href="b"'
    ]
    let seed = 97
    for (let sample = 0; sample < 3000; sample++) {
      let source = ''
      for (let token = 0; token < 12; token++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        source += tokens[seed % tokens.length]
      }
      expect(extractIconHref(source), source).toBe(originalIconHref(source))
    }
  })

  it('handles a maximum-size unterminated HTML tag region', () => {
    expect(extractIconHref('<link '.repeat(Math.floor((256 * 1024) / 6)))).toBeNull()
  })

  it('handles a maximum-size icon-free entrypoint', () => {
    expect(extractIconHref('a'.repeat(256 * 1024))).toBeNull()
  })
})
