import { describe, expect, it } from 'vitest'
import { pluginFrameKey } from '../../../shared/plugins/frames/plugin-frame-guest'
import {
  isAllowedPluginFrameNavigation,
  isAllowedPluginFrameRequestUrl,
  pluginFrameAttachKey
} from './plugin-frame-request-policy'

const KEY = pluginFrameKey('acme.charts')
const OTHER = pluginFrameKey('acme.other')

describe('plugin frame session request policy', () => {
  it.each([
    [`orca-plugin-frame://${KEY}/panel.html`, true],
    [`orca-plugin-frame://${KEY}/lib/app.wasm`, true],
    ['data:text/plain,hi', true],
    [`blob:orca-plugin-frame://${KEY}/0b1c`, true],
    ['devtools://devtools/bundled/inspector.html', true],
    [`orca-plugin-frame://${OTHER}/panel.html`, false],
    [`orca-plugin-frame://${KEY}`, false],
    ['http://127.0.0.1:8080/', false],
    ['https://example.com/beacon.gif', false],
    ['ws://127.0.0.1:9/', false],
    ['file:///etc/passwd', false],
    ['orca-plugin-image://sha/abc', false]
  ])('%s → %s', (url, allowed) => {
    expect(isAllowedPluginFrameRequestUrl(url, KEY)).toBe(allowed)
  })

  it('keeps top-level navigation on the plugin origin and lets subframes be inert', () => {
    expect(isAllowedPluginFrameNavigation(`orca-plugin-frame://${KEY}/b.html`, KEY, true)).toBe(
      true
    )
    expect(isAllowedPluginFrameNavigation(`orca-plugin-frame://${OTHER}/b.html`, KEY, true)).toBe(
      false
    )
    expect(isAllowedPluginFrameNavigation('https://example.com/', KEY, true)).toBe(false)
    expect(isAllowedPluginFrameNavigation('about:blank', KEY, true)).toBe(false)
    expect(isAllowedPluginFrameNavigation(`blob:orca-plugin-frame://${KEY}/x`, KEY, true)).toBe(
      false
    )
    expect(isAllowedPluginFrameNavigation('data:text/html,x', KEY, false)).toBe(false)
    expect(isAllowedPluginFrameNavigation('about:srcdoc', KEY, false)).toBe(true)
  })

  it('admits a webview only when its partition key is the key of its origin', () => {
    expect(pluginFrameAttachKey(KEY, `orca-plugin-frame://${KEY}/panel.html`)).toBe(KEY)
    expect(pluginFrameAttachKey(KEY, `orca-plugin-frame://${OTHER}/panel.html`)).toBeNull()
    expect(pluginFrameAttachKey(KEY, 'https://example.com/')).toBeNull()
    expect(pluginFrameAttachKey(null, `orca-plugin-frame://${KEY}/panel.html`)).toBeNull()
  })
})
