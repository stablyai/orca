// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { hostOs } from './host-os.web'

function agent(userAgent: string, platform = '', maxTouchPoints = 0) {
  Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true })
  Object.defineProperty(navigator, 'platform', { value: platform, configurable: true })
  Object.defineProperty(navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true })
}

afterEach(() => agent(''))

describe("the page's host OS", () => {
  it('reads the phone off the WebView user agent', () => {
    agent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
    )
    expect(hostOs()).toBe('ios')
    agent(
      'Mozilla/5.0 (Linux; Android 17; sdk_gphone64_arm64 Build/CP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/144.0 Mobile Safari/537.36'
    )
    expect(hostOs()).toBe('android')
  })

  it('takes an iPad, which reports a Mac, by its touch points', () => {
    agent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 'MacIntel', 5)
    expect(hostOs()).toBe('ios')
    agent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 'MacIntel', 0)
    expect(hostOs()).toBe('web')
  })
})
