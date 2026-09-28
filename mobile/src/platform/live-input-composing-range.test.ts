import { afterEach, describe, expect, it, vi } from 'vitest'
import { reportedLiveInputComposing } from './live-input-composing-range'
import { reportedLiveInputComposing as reportedPageLiveInputComposing } from './live-input-composing-range.web'

const ANDROID_WEBVIEW = 'Mozilla/5.0 (Linux; Android 16; wv) Chrome/140'
const IPHONE_WEBVIEW = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15'

describe('the composing range a live input reports', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('passes the native event through, whatever the user agent says', () => {
    vi.stubGlobal('navigator', { userAgent: ANDROID_WEBVIEW })
    expect([true, false, undefined].map(reportedLiveInputComposing)).toEqual([
      true,
      false,
      undefined
    ])
  })

  it('reports no range in an Android WebView, as native Android does', () => {
    vi.stubGlobal('navigator', { userAgent: ANDROID_WEBVIEW })
    expect([true, false, undefined].map(reportedPageLiveInputComposing)).toEqual([
      undefined,
      undefined,
      undefined
    ])
  })

  it("passes the DOM's range through in any other browser", () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE_WEBVIEW })
    expect([true, false, undefined].map(reportedPageLiveInputComposing)).toEqual([
      true,
      false,
      undefined
    ])
  })

  it('passes the range through where there is no navigator', () => {
    vi.stubGlobal('navigator', undefined)
    expect(reportedPageLiveInputComposing(true)).toBe(true)
  })
})
