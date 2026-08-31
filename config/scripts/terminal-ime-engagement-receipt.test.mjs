import { describe, expect, it } from 'vitest'
import {
  EXPECTED_NATIVE_IME_TESTS,
  verifyImeEngagementReceipts
} from './terminal-ime-engagement-receipt.mjs'

const [firstTest, secondTest] = EXPECTED_NATIVE_IME_TESTS

function receipt(test, overrides = {}) {
  return JSON.stringify({
    test,
    compositionStart: 30,
    hangulComposition: 90,
    onDataChunks: 30,
    ...overrides
  })
}

describe('verifyImeEngagementReceipts', () => {
  it('accepts a run where every expected test observed real composition', () => {
    expect(verifyImeEngagementReceipts(`${receipt(firstTest)}\n${receipt(secondTest)}\n`)).toEqual(
      []
    )
  })

  // The failure this whole mechanism exists for: Playwright reports a skipped test as a pass, so
  // an unset ORCA_E2E_NATIVE_IBUS_HANGUL produces exit code 0 and an empty receipt file.
  it('rejects an empty receipt, which is what a fully skipped run leaves behind', () => {
    const problems = verifyImeEngagementReceipts('')
    expect(problems).toHaveLength(EXPECTED_NATIVE_IME_TESTS.length)
    for (const test of EXPECTED_NATIVE_IME_TESTS) {
      expect(problems.some((problem) => problem.includes(test))).toBe(true)
    }
  })

  it('rejects a partial run where only one test reached the engine', () => {
    expect(verifyImeEngagementReceipts(`${receipt(firstTest)}\n`)).toEqual([
      `no engagement receipt for "${secondTest}" — it was skipped, filtered out, or renamed`
    ])
  })

  it('rejects a run that typed keys but never opened a composition', () => {
    const problems = verifyImeEngagementReceipts(
      `${receipt(firstTest, { compositionStart: 0 })}\n${receipt(secondTest)}\n`
    )
    expect(problems).toEqual([
      `"${firstTest}" recorded no compositionstart — the IME never engaged`
    ])
  })

  it('rejects a composition that produced no Hangul, which a latin passthrough would satisfy', () => {
    const problems = verifyImeEngagementReceipts(
      `${receipt(firstTest, { hangulComposition: 0 })}\n${receipt(secondTest)}\n`
    )
    expect(problems).toEqual([
      `"${firstTest}" recorded no Hangul composition data — the engine produced no syllables`
    ])
  })

  it('rejects a renamed test rather than counting it toward coverage', () => {
    const problems = verifyImeEngagementReceipts(
      `${receipt(firstTest)}\n${receipt(secondTest)}\n${receipt('some new scenario')}\n`
    )
    expect(problems).toEqual([
      'unexpected engagement receipt for "some new scenario" — update EXPECTED_NATIVE_IME_TESTS'
    ])
  })

  it('reports a truncated receipt rather than parsing around it', () => {
    const problems = verifyImeEngagementReceipts(
      `${receipt(firstTest)}\n{"test":"trunc\n${receipt(secondTest)}\n`
    )
    expect(problems).toEqual(['malformed receipt line: {"test":"trunc'])
  })
})
