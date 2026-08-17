import { describe, expect, it } from 'vitest'
import { resolveStockHerdrTestBinary } from './herdr-stock-binary'
import { isHerdrProcessGone } from './herdr-socket-transport'
import { HerdrRuntimeError } from './herdr-runtime-contract'

describe('resolveStockHerdrTestBinary', () => {
  it('returns a string or null without throwing', () => {
    const binary = resolveStockHerdrTestBinary()
    expect(binary === null || typeof binary === 'string').toBe(true)
  })
})

describe('isHerdrProcessGone', () => {
  it('treats connection failures as a dead process', () => {
    expect(isHerdrProcessGone(Object.assign(new Error('gone'), { code: 'ECONNREFUSED' }))).toBe(
      true
    )
    expect(isHerdrProcessGone(new Error('Connection to /tmp/x.sock timed out'))).toBe(true)
    expect(isHerdrProcessGone(new HerdrRuntimeError('not_git_worktree', 'no'))).toBe(false)
  })
})
