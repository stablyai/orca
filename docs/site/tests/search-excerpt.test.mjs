import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { stripSearchExcerptMarkdown } from '../src/components/docs/search-excerpt.mjs'

test('unterminated escaped link destinations do not backtrack exponentially', () => {
  for (const prefix of ['![](', '[label](']) {
    const input = prefix + '\\('.repeat(32_768)
    const result = runInNewContext(
      'strip(input)',
      { strip: stripSearchExcerptMarkdown, input },
      {
        timeout: 250
      }
    )
    assert.equal(result, input.replace(/\\\(/g, '('))
  }
})

test('link destinations retain escaped closing parentheses and literal escapes', () => {
  for (const prefix of ['![label](', '[label](']) {
    assert.equal(stripSearchExcerptMarkdown(prefix + 'https://example.com/a\\)b)'), 'label')
    assert.equal(stripSearchExcerptMarkdown(prefix + 'https://example.com/a\\(b)'), 'label')
    assert.equal(stripSearchExcerptMarkdown(prefix + 'https://example.com/a\\)'), 'label')
    assert.equal(stripSearchExcerptMarkdown(prefix + 'https://example.com/a\\\\))'), 'label)')
    assert.equal(stripSearchExcerptMarkdown(prefix + 'https://example.com/a\\\nb)'), 'label')
  }
})

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

test('unclosed angles finish within the excerpt budget without changing text', () => {
  const input = '<'.repeat(131_072)
  const result = runInNewContext(
    'strip(input)',
    { strip: stripSearchExcerptMarkdown, input },
    { timeout: 250 }
  )
  assert.equal(result, input)
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

test('unclosed brackets finish within the excerpt budget without changing text', () => {
  const input = '['.repeat(131_072)
  const result = runInNewContext(
    'strip(input)',
    { strip: stripSearchExcerptMarkdown, input },
    { timeout: 250 }
  )
  assert.equal(result, input)
})
