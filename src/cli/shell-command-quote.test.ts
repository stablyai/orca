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
    // cmd.exe splits on spaces and does not treat single quotes as delimiters.
    expect(quoteCliCommandArgument('Text Editor')).toBe('"Text Editor"')
  })

  it('keeps a dollar sign literal for both PowerShell and cmd.exe', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    expect(quoteCliCommandArgument('path:C:/work/$review')).toBe('path:C:/work/$"r"eview')
    expect(quoteCliCommandArgument('a b$c')).toBe('a" "b$"c"')
    // cmd.exe splits on an unquoted &; single quotes would not hide it.
    expect(quoteCliCommandArgument('a&b$c')).toBe('a"&"b$"c"')
    expect(quoteCliCommandArgument('a$$b')).toBe('a$"$"b')
    expect(quoteCliCommandArgument('path:C:/work/$$()')).toBe('path:C:/work/$"`$()"')
    expect(quoteCliCommandArgument("path:C:/work/$r'x")).toBe(`path:C:/work/$"r'"x`)
    expect(quoteCliCommandArgument('path:C:/work/\\\\\\ $review')).toBe(
      'path:C:/work/"\\\\\\ "$"r"eview'
    )
    expect(quoteCliCommandArgument(' $review')).toBe('" `$review"')
  })
})
