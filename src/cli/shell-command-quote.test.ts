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
    expect(quoteCliCommandArgument('Text Editor')).toBe("'Text Editor'")
  })

  it('quotes values for specific Windows shell families', () => {
    expect(quoteCliCommandArgument('Text Editor', { shell: 'powershell', platform: 'win32' })).toBe(
      "'Text Editor'"
    )

    expect(quoteCliCommandArgument('Text Editor', { shell: 'cmd', platform: 'win32' })).toBe(
      '"Text Editor"'
    )
  })

  it('protects dollar signs from PowerShell variable expansion', () => {
    expect(
      quoteCliCommandArgument('path:C:/work/$review', { shell: 'powershell', platform: 'win32' })
    ).toBe("'path:C:/work/$review'")

    expect(
      quoteCliCommandArgument('path:C:/work/$review', { shell: 'cmd', platform: 'win32' })
    ).toBe('"path:C:/work/$review"')
  })

  it('detects shell family from environment variables on win32', () => {
    expect(
      quoteCliCommandArgument('path:C:/work/$review', {
        platform: 'win32',
        env: { ORCA_TERMINAL_WINDOWS_SHELL: 'powershell.exe' }
      })
    ).toBe("'path:C:/work/$review'")

    expect(
      quoteCliCommandArgument('path:C:/work/$review', {
        platform: 'win32',
        env: { ORCA_TERMINAL_WINDOWS_SHELL: 'cmd.exe' }
      })
    ).toBe('"path:C:/work/$review"')

    expect(
      quoteCliCommandArgument('path:C:/work/$review', {
        platform: 'win32',
        env: { ORCA_WINDOWS_SHELL: 'cmd.exe' }
      })
    ).toBe('"path:C:/work/$review"')
  })

  it('escapes embedded quotes correctly for PowerShell', () => {
    expect(
      quoteCliCommandArgument("path:C:/work/$it's", { shell: 'powershell', platform: 'win32' })
    ).toBe("'path:C:/work/$it''s'")
  })
})
