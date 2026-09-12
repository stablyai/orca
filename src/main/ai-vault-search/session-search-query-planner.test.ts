import { describe, expect, it } from 'vitest'
import {
  andExpression,
  isLiteralQuery,
  orExpression,
  phraseExpression,
  planSessionSearchQuery,
  quoteFtsTerm
} from './session-search-query-planner'

describe('literal shape decides whether the phrase route is even tried', () => {
  it.each([
    'resolveTerminalPath',
    'src/main/foo-bar.ts',
    'MAX_RETRY_COUNT',
    'kern.tty.ptmx_max',
    '#19687',
    'STA-4850',
    '"exact words here"',
    'TypeError: undefined',
    'foo() {'
  ])('treats %s as quoting something from a transcript', (query) => {
    expect(isLiteralQuery(query)).toBe(true)
  })

  it.each(['why is the terminal slow', 'how do I resume a session', 'relay capacity'])(
    'treats %s as prose',
    (query) => {
      expect(isLiteralQuery(query)).toBe(false)
    }
  )
})

describe('the body is what the phrase and AND routes see', () => {
  it('drops stop words from prose so the AND route is not defeated by "the"', () => {
    expect(planSessionSearchQuery('why is the relay dropping frames').body).toEqual([
      'relay',
      'dropping',
      'frames'
    ])
  })

  it('keeps stop words inside a literal, where they are part of what was quoted', () => {
    // The literal shape is `foo.ts`; dropping `the` would change what was typed.
    expect(planSessionSearchQuery('the foo.ts file').body).toEqual(['the', 'foo.ts', 'file'])
  })

  it('keeps a query that is nothing but stop words rather than answering nothing', () => {
    expect(planSessionSearchQuery('how do I').body).toEqual(['how', 'do', 'I'])
  })

  it('has no terms for a query with no searchable token', () => {
    expect(planSessionSearchQuery('   ...  ').terms).toEqual([])
  })
})

describe('the OR fallback fans an identifier out into its pieces', () => {
  it('adds the split pieces after the whole term, never in place of it', () => {
    const plan = planSessionSearchQuery('resolveTerminalPath')
    expect(plan.terms[0]).toBe('resolveTerminalPath')
    expect(plan.terms).toContain('terminal')
    expect(plan.terms).toContain('path')
    // `resolve` is not a stop word, so the whole identifier is reachable by piece.
    expect(plan.terms).toContain('resolve')
  })

  it('leaves an ordinary word alone', () => {
    expect(planSessionSearchQuery('relay').terms).toEqual(['relay'])
  })
})

describe('FTS5 expressions quote every term', () => {
  it('quotes punctuation that would otherwise be syntax', () => {
    expect(quoteFtsTerm('cli.mjs')).toBe('"cli.mjs"')
    expect(quoteFtsTerm('C++')).toBe('"C++"')
    expect(quoteFtsTerm('say "hi"')).toBe('"say ""hi"""')
  })

  it('builds one phrase, an AND chain, and an OR chain from the same terms', () => {
    expect(phraseExpression(['alpha', 'beta'])).toBe('"alpha beta"')
    expect(andExpression(['alpha', 'beta'])).toBe('"alpha" AND "beta"')
    expect(orExpression(['alpha', 'beta'])).toBe('"alpha" OR "beta"')
  })
})
