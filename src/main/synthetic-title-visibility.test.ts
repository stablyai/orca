import { describe, expect, it } from 'vitest'
import { shouldSendSyntheticTitleFrame } from './synthetic-title-visibility'

describe('shouldSendSyntheticTitleFrame', () => {
  it('skips decorative spinner frames only while the window is hidden', () => {
    expect(shouldSendSyntheticTitleFrame({ force: false, windowVisible: false })).toBe(false)
    expect(shouldSendSyntheticTitleFrame({ force: false, windowVisible: true })).toBe(true)
  })

  it('always sends forced terminal-state frames', () => {
    expect(shouldSendSyntheticTitleFrame({ force: true, windowVisible: false })).toBe(true)
  })
})
