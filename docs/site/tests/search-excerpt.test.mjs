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
