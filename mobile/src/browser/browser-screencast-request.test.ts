import { describe, expect, it } from 'vitest'

import { buildMobileBrowserScreencastRequest } from './browser-screencast-request'

describe('buildMobileBrowserScreencastRequest', () => {
  it('requests sharp frames without changing the remote browser viewport', () => {
    const request = buildMobileBrowserScreencastRequest({ width: 390, height: 640 }, 3)

    expect(request).toEqual({
      format: 'jpeg',
      quality: 72,
      maxWidth: 975,
      maxHeight: 1600,
      everyNthFrame: 1,
      minFrameIntervalMs: 100
    })
    expect(Object.keys(request ?? {})).not.toEqual(
      expect.arrayContaining(['viewportWidth', 'viewportHeight', 'deviceScaleFactor', 'mobile'])
    )
  })

  it('caps large phone layouts to the stream frame budget', () => {
    expect(buildMobileBrowserScreencastRequest({ width: 1200, height: 1200 }, 3)).toMatchObject({
      maxWidth: 2400,
      maxHeight: 2160
    })
  })

  it('waits for a measured browser pane before subscribing', () => {
    expect(buildMobileBrowserScreencastRequest(null, 2)).toBeNull()
    expect(buildMobileBrowserScreencastRequest({ width: 0, height: 640 }, 2)).toBeNull()
  })
})
