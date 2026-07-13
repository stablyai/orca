import { describe, expect, it } from 'vitest'
import { isChatImportHostRun } from './chat-import-host-argv'

describe('isChatImportHostRun', () => {
  it('recognizes a bare host launch', () => {
    expect(isChatImportHostRun(['chat-import-host'])).toBe(true)
  })

  it('recognizes a host launch with the Chrome extension origin appended', () => {
    expect(isChatImportHostRun(['chat-import-host', 'chrome-extension://abc/'])).toBe(true)
  })

  it('recognizes a host launch with origin and Windows --parent-window appended', () => {
    expect(
      isChatImportHostRun(['chat-import-host', 'chrome-extension://abc/', '--parent-window=12345'])
    ).toBe(true)
  })

  it('does not treat `chat-import-host install` as a host run', () => {
    expect(isChatImportHostRun(['chat-import-host', 'install', '--extension-id', 'x'])).toBe(false)
  })

  it('does not treat unrelated commands as a host run', () => {
    expect(isChatImportHostRun(['serve'])).toBe(false)
  })
})
