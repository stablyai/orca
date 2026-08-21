import { describe, expect, it } from 'vitest'
import {
  canonicalizeLinearProjectContent,
  isClearedLinearProjectContent,
  linearProjectContentWriteValue,
  sameLinearProjectContent
} from './project-content-rewrites'

const COMMIT_URL =
  'https://github.com/stablyai/orca/commit/516a269315f872701091f89756c04fe210ef1be8'

/**
 * Every pair here was captured from the live Linear API: the first value is what
 * `projectUpdate` was given, the second is what the following read returned.
 */
describe('Linear project content rewrites', () => {
  it.each([
    [
      'a bare URL becomes a labelled autolink',
      `see ${COMMIT_URL} end`,
      `see [${COMMIT_URL}](<${COMMIT_URL}>) end`
    ],
    [
      'a bare host gains an http:// destination',
      'visit www.example.com now',
      'visit [www.example.com](<http://www.example.com>) now'
    ],
    [
      'an angle autolink becomes a labelled autolink',
      'a <https://example.com/x> b',
      'a [https://example.com/x](<https://example.com/x>) b'
    ],
    [
      'a relative link destination gains angle brackets',
      'go [there](/rel) now',
      'go [there](</rel>) now'
    ],
    ['trailing whitespace is stripped', 'overview\n', 'overview'],
    ['plain prose survives untouched', 'no links here at all', 'no links here at all']
  ])('%s', (_label, sent, stored) => {
    expect(sameLinearProjectContent(sent, stored)).toBe(true)
  })

  // Why: the canonical form only exists to stop false alarms, so a genuinely
  // lost or altered body must still read as different.
  it.each([
    ['truncation', 'the whole overview', 'the whole'],
    ['an emptied body', 'the whole overview', ''],
    ['a changed link label', '[before](/x)', '[after](/x)'],
    ['a changed destination', `see ${COMMIT_URL}`, 'see https://example.com/other']
  ])('still reports %s as a difference', (_label, sent, stored) => {
    expect(sameLinearProjectContent(sent, stored)).toBe(false)
  })

  // Why: Linear stores whitespace-only content as '' and refuses to go back to
  // null, so every empty spelling is the same cleared state.
  it('treats every empty spelling as the same cleared body', () => {
    for (const value of [null, '', ' ', '\n', '  \n ']) {
      expect(isClearedLinearProjectContent(value)).toBe(true)
      expect(sameLinearProjectContent(value, null)).toBe(true)
      expect(sameLinearProjectContent(value, '')).toBe(true)
    }
    expect(sameLinearProjectContent(null, 'overview')).toBe(false)
  })

  // Why: Linear reports success and keeps the old body when content is null or '',
  // so a clear has to travel as whitespace to actually land.
  it('sends a clear as whitespace and everything else verbatim', () => {
    expect(linearProjectContentWriteValue(null)).toBe(' ')
    expect(linearProjectContentWriteValue('')).toBe(' ')
    expect(linearProjectContentWriteValue('overview')).toBe('overview')
  })

  it('leaves a link whose label is not its destination alone', () => {
    expect(canonicalizeLinearProjectContent('[docs](https://example.com)')).toBe(
      '[docs](https://example.com)'
    )
  })

  // Why: Linear's rewrite is stable, so canonicalizing a stored value must be a fixed point.
  it('is idempotent over an already-rewritten body', () => {
    const stored = `see [${COMMIT_URL}](<${COMMIT_URL}>) end`
    const once = canonicalizeLinearProjectContent(stored)
    expect(canonicalizeLinearProjectContent(once)).toBe(once)
  })

  // Why: an earlier fix bounded the label match to keep the scan fast, which broke
  // convergence for any URL past that bound. The scan is linear-time now, so no
  // length should matter — prove it well past that old bound.
  it('round-trips a bare URL far longer than any earlier length bound', () => {
    const longUrl = `${COMMIT_URL}?ref=${'a'.repeat(2000)}`
    const sent = `see ${longUrl} end`
    const stored = `see [${longUrl}](<${longUrl}>) end`
    expect(sameLinearProjectContent(sent, stored)).toBe(true)
  })

  // Why: a backtracking regex over unmatched delimiters is quadratic; a linear
  // scan stays fast regardless of how many opens never close.
  it('canonicalizes many unmatched delimiters in linear time', () => {
    const adversarial = '[a('.repeat(20000) + '<b '.repeat(20000)
    const start = performance.now()
    canonicalizeLinearProjectContent(adversarial)
    expect(performance.now() - start).toBeLessThan(200)
  })
})
