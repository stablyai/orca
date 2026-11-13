import { describe, expect, it } from 'vitest'
import { assertAgentBrowserPassthroughStaysOnPage } from './agent-browser-passthrough-arguments'

describe('assertAgentBrowserPassthroughStaysOnPage', () => {
  it.each([
    [['connect', '9222']],
    [['tab', 'new']],
    [['window', 'new']],
    [['close']],
    [['set', 'viewport', '800', '600']],
    [['set', 'device', 'iPhone 15']],
    [['click', '@e1', '--new-tab']],
    [['get', 'text', '@e3', '--cdp', 'ws://127.0.0.1:9222']],
    [['get', 'url', '--session=other']],
    [['snapshot', '--auto-connect']],
    [['open', 'https://example.com', '-p', 'browserbase']],
    [['fill', '@e1', '--headed']],
    [['batch', 'get title', 'connect 9222']],
    [['batch', '--bail', 'tab new']],
    [['batch', 'c\\onnect 9222']],
    [['batch', 'batch "tab new"']],
    [['batch', 'get url --cdp 9222']]
  ])('refuses %j', (args) => {
    expect(() => assertAgentBrowserPassthroughStaysOnPage(args)).toThrow(
      expect.objectContaining({ code: 'invalid_argument' })
    )
  })

  it.each([
    [['get', 'text', '@e3']],
    [['read']],
    [['is', 'visible', '@e3']],
    [['set', 'media', 'dark']],
    [['wait', '--text', 'Done']],
    [['batch', '--bail', 'get title', 'snapshot -i']]
  ])('runs %j', (args) => {
    expect(() => assertAgentBrowserPassthroughStaysOnPage(args)).not.toThrow()
  })
})
