import { describe, expect, it } from 'vitest'
import {
  PREVIOUS_MESSAGE_ALIGN_PX,
  endAnchoredScrollTopForRow,
  isPreviousMessageStop,
  previousMessageTarget,
  type PreviousMessageStop
} from './mobile-native-chat-previous-message'

const stops = (...tops: (number | undefined)[]): PreviousMessageStop[] =>
  tops.map((top, index) => (top === undefined ? { key: `m${index}` } : { key: `m${index}`, top }))

describe('previous message target', () => {
  it('lands on the nearest stop whose top is above the viewport', () => {
    expect(previousMessageTarget(stops(-400, -120, -20, 80))).toEqual({ key: 'm2' })
  })

  it('steps back when the current stop is already aligned to the top', () => {
    expect(previousMessageTarget(stops(-300, -PREVIOUS_MESSAGE_ALIGN_PX, 40))).toEqual({
      key: 'm0'
    })
    expect(previousMessageTarget(stops(-4, 200))).toBeNull()
  })

  it('uses the current message when its start is still above the fold', () => {
    expect(previousMessageTarget(stops(-48))).toEqual({ key: 'm0' })
  })

  it('hides the jump at the first message', () => {
    expect(previousMessageTarget(stops(0))).toBeNull()
    expect(previousMessageTarget(stops(12, 400))).toBeNull()
    expect(previousMessageTarget([])).toBeNull()
  })

  it('asks for an undrawn earlier stop before scrolling', () => {
    expect(previousMessageTarget(stops(undefined, undefined, 2))).toEqual({ pendingKey: 'm1' })
  })

  it('prefers a drawn stop above the fold over older undrawn rows', () => {
    expect(previousMessageTarget(stops(undefined, -90, 10))).toEqual({ key: 'm1' })
  })

  it('ignores an undrawn row that comes after a measured stop', () => {
    expect(previousMessageTarget(stops(-20, undefined))).toEqual({ key: 'm0' })
  })

  it('stays unknown until a row has been measured', () => {
    expect(previousMessageTarget(stops(undefined, undefined))).toBeNull()
  })

  it('stops on user and assistant messages that are actually drawn', () => {
    expect(isPreviousMessageStop('user', {})).toBe(true)
    expect(isPreviousMessageStop('assistant', {})).toBe(true)
    expect(isPreviousMessageStop('tool', {})).toBe(false)
    expect(isPreviousMessageStop('reasoning', {})).toBe(false)
    expect(isPreviousMessageStop('system', {})).toBe(false)
    expect(isPreviousMessageStop('assistant', { joinsWorkRun: true })).toBe(false)
    expect(isPreviousMessageStop('user', { foldedAway: true })).toBe(false)
  })

  it('moves an end-anchored list toward older rows to bring a top down to the viewport', () => {
    expect(endAnchoredScrollTopForRow(-200, 60, 100)).toBe(-240)
    expect(endAnchoredScrollTopForRow(-200, 100, 100)).toBe(-200)
  })
})
