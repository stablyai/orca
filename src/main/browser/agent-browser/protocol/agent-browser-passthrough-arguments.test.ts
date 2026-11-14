import { describe, expect, it } from 'vitest'
import { assertAgentBrowserPassthroughStaysOnPage } from './agent-browser-passthrough-arguments'

describe('assertAgentBrowserPassthroughStaysOnPage', () => {
  it.each([
    [['batch', 'c\\onnect 9222']],
    [['batch', 'close\\']],
    [['batch', 'batch "tab new"']],
    [['batch', 'get url --cdp 9222']]
  ])('refuses %j', (args) => {
    expect(() => assertAgentBrowserPassthroughStaysOnPage(args)).toThrow(
      expect.objectContaining({ code: 'invalid_argument' })
    )
  })
})
