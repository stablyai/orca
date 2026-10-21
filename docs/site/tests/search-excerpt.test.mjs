import assert from 'node:assert/strict'
import test from 'node:test'
import { stripSearchExcerptMarkdown } from '../src/components/docs/search-excerpt.mjs'

test('search excerpts omit inline Markdown syntax', () => {
  assert.equal(
    stripSearchExcerptMarkdown(
      'Use **bold**, *emphasis*, `inline code`, and [linked text](https://example.com).'
    ),
    'Use bold, emphasis, inline code, and linked text.'
  )
})

test('search excerpts preserve highlighted matches inside Markdown', () => {
  assert.equal(
    stripSearchExcerptMarkdown('**<mark>Privacy</mark> controls**'),
    '<mark>Privacy</mark> controls'
  )
  assert.equal(
    stripSearchExcerptMarkdown('[Open <mark>settings</mark>](https://example.com/settings)'),
    'Open <mark>settings</mark>'
  )
  assert.equal(
    stripSearchExcerptMarkdown('Use `<mark>git</mark> **status**`'),
    'Use <mark>git</mark> **status**'
  )
  assert.equal(
    stripSearchExcerptMarkdown('<mark>**Privacy controls**</mark>'),
    '<mark>Privacy controls</mark>'
  )
  assert.equal(stripSearchExcerptMarkdown('<mark>`git status`</mark>'), '<mark>git status</mark>')
  assert.equal(
    stripSearchExcerptMarkdown('<mark>[Privacy controls](https://example.com/privacy)</mark>'),
    '<mark>Privacy controls</mark>'
  )
})

test('unclosed angles avoid the HTML matcher without changing excerpt text', () => {
  const input = '<'.repeat(8192)
  const replace = String.prototype.replace
  let tagMatcherCalls = 0
  String.prototype.replace = function (pattern, ...args) {
    if (pattern instanceof RegExp && pattern.source === '<[^>]+>' && pattern.flags === 'g') {
      tagMatcherCalls += 1
    }
    return Reflect.apply(replace, this, [pattern, ...args])
  }
  try {
    assert.equal(stripSearchExcerptMarkdown(input), input)
  } finally {
    String.prototype.replace = replace
  }
  assert.equal(tagMatcherCalls, 0)
})

test('tag guards preserve malformed markup, protected code and highlighted matches', () => {
  const cases = [
    ['<em>**bold**</em>', 'bold'],
    ['<> **bold**', '<> bold'],
    ['<<em>bold</em>', 'bold'],
    ['<tag\nattr>hello</tag>', 'hello'],
    ['`<em>**literal**</em>`', '<em>**literal**</em>'],
    ['<mark>**highlight**</mark>', '<mark>highlight</mark>'],
    ['<MARK>**highlight**</MARK>', '<MARK>highlight</MARK>'],
    ['[<label](https://example.com/a>)', '<label'],
    ['<a **bold**', '<a bold'],
    ['<mark><<<</mark>', '<mark><<<</mark>'],
    ['\\> <tag>text</tag>', '> text'],
    ['plain > text', 'plain > text'],
    ['<!>text', 'text'],
    ['<><', '<><'],
    ['<\0orca-search-code-99\0', '<'],
    ['Use <mark>[**unclosed**</mark>', 'Use <mark>[unclosed</mark>'],
    ['<span>[<em>text</em></span>', '[text'],
    ['Use `[**literal**` and **emphasis**', 'Use [**literal** and emphasis'],
    ['![<mark>alt</mark>](url)', '<mark>alt</mark>'],
    ['[[path]]', 'path'],
    ['[label][ref]', 'label'],
    [']', ']']
  ]
  for (const [input, expected] of cases) {
    assert.equal(stripSearchExcerptMarkdown(input), expected, input)
  }
})

test('unclosed brackets avoid link matchers without changing excerpt text', () => {
  const input = '['.repeat(4096)
  const replace = String.prototype.replace
  let linkMatcherCalls = 0
  String.prototype.replace = function (pattern, ...args) {
    if (
      pattern instanceof RegExp &&
      pattern.source.includes('\\[') &&
      pattern.source.includes('\\]')
    ) {
      linkMatcherCalls += 1
    }
    return Reflect.apply(replace, this, [pattern, ...args])
  }
  try {
    assert.equal(stripSearchExcerptMarkdown(input), input)
  } finally {
    String.prototype.replace = replace
  }
  assert.equal(linkMatcherCalls, 0)
})
