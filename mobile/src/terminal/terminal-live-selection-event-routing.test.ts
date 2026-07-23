import { describe, expect, it } from 'vitest'
import {
  classifyTerminalLiveSelectionEvent,
  isTerminalLiveFieldOwnedArrowKey,
  shouldApplyTerminalLiveCursorOnlySelectionMove
} from './terminal-live-selection-event-routing'

describe('terminal live selection event routing', () => {
  it('Given a text change When selection follows Then classifies as paired-with-text-change', () => {
    expect(classifyTerminalLiveSelectionEvent(true)).toBe('paired-with-text-change')
  })

  it('Given no text change When selection arrives Then classifies as cursor-only', () => {
    expect(classifyTerminalLiveSelectionEvent(false)).toBe('cursor-only')
  })

  it('Given paired selection with held Hangul Then does not apply cursor-only move', () => {
    expect(
      shouldApplyTerminalLiveCursorOnlySelectionMove({
        kind: 'paired-with-text-change',
        heldText: '한',
        allowSoftReseatWhenPaired: true
      })
    ).toBe(false)
  })

  it('Given paired selection without held text Then allows soft reseat', () => {
    expect(
      shouldApplyTerminalLiveCursorOnlySelectionMove({
        kind: 'paired-with-text-change',
        heldText: '',
        allowSoftReseatWhenPaired: true
      })
    ).toBe(true)
  })

  it('Given cursor-only selection Then always applies the move plan', () => {
    expect(
      shouldApplyTerminalLiveCursorOnlySelectionMove({
        kind: 'cursor-only',
        heldText: '글',
        allowSoftReseatWhenPaired: false
      })
    ).toBe(true)
  })

  it('Given ArrowLeft/Right Then marks them as field-owned arrow keys', () => {
    expect(isTerminalLiveFieldOwnedArrowKey('ArrowLeft')).toBe(true)
    expect(isTerminalLiveFieldOwnedArrowKey('ArrowRight')).toBe(true)
    expect(isTerminalLiveFieldOwnedArrowKey('ArrowUp')).toBe(false)
  })
})
