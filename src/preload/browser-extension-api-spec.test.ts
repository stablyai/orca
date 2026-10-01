import { describe, expect, it } from 'vitest'
import * as shared from '../shared/browser-extension-channels'
import * as spec from './browser-extension-api-spec'

describe('browser extension channels', () => {
  it("match main's", () => {
    expect(spec.BROWSER_EXTENSION_CALL_CHANNEL).toBe(shared.BROWSER_EXTENSION_CALL_CHANNEL)
    expect(spec.BROWSER_EXTENSION_EVENT_CHANNEL).toBe(shared.BROWSER_EXTENSION_EVENT_CHANNEL)
  })
})
