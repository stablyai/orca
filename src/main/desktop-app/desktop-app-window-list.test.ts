import { describe, expect, it } from 'vitest'
import { parseDesktopAppWindows, resolveListedTarget } from './desktop-app-window-list'

describe('parseDesktopAppWindows', () => {
  it('keeps well-formed windows and drops malformed entries', () => {
    expect(
      parseDesktopAppWindows({
        windows: [
          {
            windowId: 12396,
            pid: 62961,
            appName: 'Notes',
            bundleId: null,
            title: 'Notes',
            bounds: { x: 2110, y: -60, width: 1280, height: 1016 }
          },
          { windowId: 'x', pid: 1, appName: 'Bad', bounds: {} },
          null
        ]
      })
    ).toEqual([
      {
        windowId: 12396,
        pid: 62961,
        appName: 'Notes',
        bundleId: null,
        title: 'Notes',
        bounds: { x: 2110, y: -60, width: 1280, height: 1016 }
      }
    ])
  })

  it('returns an empty list for unexpected payloads', () => {
    expect(parseDesktopAppWindows(undefined)).toEqual([])
    expect(parseDesktopAppWindows({ windows: 'nope' })).toEqual([])
  })
})

describe('resolveListedTarget', () => {
  const windows = parseDesktopAppWindows({
    windows: [{ windowId: 7, pid: 42, appName: 'A', bounds: { x: 0, y: 0, width: 10, height: 10 } }]
  })

  it('confirms a pair the native list agrees with', () => {
    expect(resolveListedTarget(windows, { windowId: 7, pid: 42 })).toEqual({ windowId: 7, pid: 42 })
  })

  it('rejects a pid that does not own the window', () => {
    expect(() => resolveListedTarget(windows, { windowId: 7, pid: 43 })).toThrow(
      'does not belong to process 43'
    )
  })

  it('rejects a window the native list no longer shows', () => {
    expect(() => resolveListedTarget(windows, { windowId: 8, pid: 42 })).toThrow('no longer open')
  })
})
