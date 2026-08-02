import { afterEach, describe, expect, it, vi } from 'vitest'
import { quoteCliCommandArgument } from './shell-command-quote'

describe('quoteCliCommandArgument', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('leaves simple selectors unquoted', () => {
    expect(quoteCliCommandArgument('com.apple.finder')).toBe('com.apple.finder')
  })

  it('quotes values with spaces for the current platform shell', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    expect(quoteCliCommandArgument('Text Editor')).toBe("'Text Editor'")

    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    expect(quoteCliCommandArgument('Text Editor')).toBe('"Text Editor"')
  })
})
