import { describe, expect, it } from 'vitest'
import { findRemoteScrollRegion, remoteScrollRows } from './remote-scroll-region.mjs'

const snapshot = (values: string[], color = 'default') =>
  values.map((text) => ({ text, key: JSON.stringify([text, color]) }))
const body = (start: number, count = 12) =>
  Array.from({ length: count }, (_, i) => `work item ${start + i}`)

// A real rendered screen reduced to which rows were identical, repeated or blank; it carries no
// conversation text and no cell attributes.
const sparseFrame = {
  before: [
    [1, 4],
    [2, 0],
    [3, 4],
    [4, 4],
    [5, 4],
    [2, 0],
    [6, 4],
    [2, 0],
    [7, 4],
    [2, 0],
    [8, 4],
    [2, 0],
    [9, 4],
    [10, 4],
    [2, 0],
    [11, 4],
    [2, 0],
    [12, 4],
    [13, 4],
    [14, 4],
    [15, 4],
    [2, 0],
    [16, 2],
    [2, 0],
    [17, 4],
    [18, 4],
    [19, 4],
    [20, 4],
    [21, 4],
    [22, 4],
    [23, 4],
    [24, 1],
    [23, 4],
    [2, 0],
    [25, 4]
  ],
  after: [
    [1, 4],
    [6, 4],
    [2, 0],
    [3, 4],
    [4, 4],
    [5, 4],
    [2, 0],
    [6, 4],
    [2, 0],
    [7, 4],
    [2, 0],
    [8, 4],
    [2, 0],
    [9, 4],
    [10, 4],
    [2, 0],
    [11, 4],
    [2, 0],
    [12, 4],
    [13, 4],
    [14, 4],
    [15, 4],
    [2, 0],
    [16, 2],
    [2, 0],
    [17, 4],
    [18, 4],
    [19, 4],
    [26, 4],
    [22, 4],
    [23, 4],
    [24, 1],
    [23, 4],
    [2, 0],
    [25, 4]
  ]
}
const sparseRows = (values: number[][]) =>
  values.map(([key, length]) => ({ key: String(key), text: 'x'.repeat(length) }))

describe('remote scroll frame correspondence', () => {
  it.each([1, 2, -1, -3])('finds the body while keeping header and footer fixed (%i)', (delta) => {
    const before = snapshot(['Title: previous status', ...body(100), 'Input: waiting'])
    const after = snapshot(['Title: new status', ...body(100 - delta), 'Input: waiting'])
    expect(findRemoteScrollRegion(before, after, Math.sign(delta))).toEqual({
      start: 1,
      end: 12,
      delta,
      matches: 12 - Math.abs(delta)
    })
  })

  it('does not turn opposite output, a status change, or an edited body into scrolling', () => {
    const before = snapshot(['Title: status', ...body(100), 'Input: waiting'])
    const moved = snapshot(['Title: status', ...body(99), 'Input: waiting'])
    expect(findRemoteScrollRegion(before, moved, -1)).toBeNull()
    expect(
      findRemoteScrollRegion(before, snapshot(['Another title', ...body(100), 'Input: waiting']), 1)
    ).toBeNull()
    moved[6] = snapshot(['The running task changed'])[0]
    expect(findRemoteScrollRegion(before, moved, 1)).toBeNull()
  })

  it('rejects repeated rows and changed cell appearance', () => {
    const repeated = snapshot(Array(20).fill('repeated line'))
    expect(findRemoteScrollRegion(repeated, repeated, 1)).toBeNull()
    expect(
      findRemoteScrollRegion(snapshot(body(100), 'red'), snapshot(body(99), 'green'), 1)
    ).toBeNull()
  })

  it('recognizes a mostly blank real screen whose unique rows and every row moved alike', () => {
    const before = sparseRows(sparseFrame.before)
    const after = sparseRows(sparseFrame.after)
    expect(findRemoteScrollRegion(before, after, 1)).toEqual({
      start: 2,
      end: 27,
      delta: 1,
      matches: 15
    })
    expect(findRemoteScrollRegion(after, before, -1)).toEqual({
      start: 2,
      end: 27,
      delta: -1,
      matches: 15
    })
  })

  it('rejects a mostly blank screen that stood still, moved back, or restyled a blank row', () => {
    const before = sparseRows(sparseFrame.before)
    const after = sparseRows(sparseFrame.after)
    expect(findRemoteScrollRegion(before, before, 1)).toBeNull()
    expect(findRemoteScrollRegion(before, after, -1)).toBeNull()
    expect(after[6].text).toBe('')
    after[6] = { ...after[6], key: 'restyled' }
    expect(findRemoteScrollRegion(before, after, 1)).toBeNull()
  })

  it('does not read a blank screen with fewer than four unique rows as a move', () => {
    const before = snapshot(['', 'line one', '', 'line two', '', 'line three', '', ''])
    const after = snapshot(['', '', 'line one', '', 'line two', '', 'line three', ''])
    expect(findRemoteScrollRegion(before, after, 1)).toBeNull()
  })

  it('does not join two regions apart across blank rows when two moves have equal evidence', () => {
    const before = snapshot(Array(24).fill(''))
    const after = snapshot(Array(24).fill(''))
    const first = snapshot(body(10, 4))
    const second = snapshot(body(30, 4))
    before.splice(1, 4, ...first)
    after.splice(2, 4, ...first)
    before.splice(14, 4, ...second)
    after.splice(16, 4, ...second)
    expect(findRemoteScrollRegion(before, after, 1)).toBeNull()
  })

  it('includes cell colors and extended attributes in a frame identity', () => {
    let color = 1
    const terminal = {
      rows: 1,
      cols: 2,
      buffer: {
        active: {
          viewportY: 0,
          getLine: () => ({
            translateToString: () => 'same text',
            getCell: () => ({ fg: color, bg: 0, extended: { ext: 0, urlId: 0 } })
          })
        }
      }
    }
    const before = remoteScrollRows(terminal)
    color = 2
    expect(remoteScrollRows(terminal)?.[0].key).not.toBe(before?.[0].key)
  })
  it('keeps identical rendered links comparable when xterm renews their internal IDs', () => {
    let linkId = 1
    const terminal = {
      rows: 1,
      cols: 2,
      buffer: {
        active: {
          viewportY: 0,
          getLine: () => ({
            translateToString: () => 'document link',
            getCell: () => ({ fg: 1, bg: 0, extended: { ext: 0, urlId: linkId } })
          })
        }
      }
    }
    const before = remoteScrollRows(terminal)
    linkId = 2
    expect(remoteScrollRows(terminal)?.[0].key).toBe(before?.[0].key)
  })
})
