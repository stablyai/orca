import { afterEach, describe, expect, it, vi } from 'vitest'
import { quoteCliCommandArgument } from './shell-command-quote'

describe('quoteCliCommandArgument on Windows', () => {
  const savedEnv = {
    ORCA_TERMINAL_WINDOWS_SHELL: process.env.ORCA_TERMINAL_WINDOWS_SHELL,
    ORCA_WINDOWS_SHELL: process.env.ORCA_WINDOWS_SHELL,
    MSYSTEM: process.env.MSYSTEM,
    PROMPT: process.env.PROMPT,
    SHELL: process.env.SHELL
  }

  afterEach(() => {
    vi.restoreAllMocks()
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  function clearShellEnv(): void {
    delete process.env.ORCA_TERMINAL_WINDOWS_SHELL
    delete process.env.ORCA_WINDOWS_SHELL
    delete process.env.MSYSTEM
    delete process.env.PROMPT
    delete process.env.SHELL
  }

  it('uses cmd-safe double quotes in cmd.exe instead of PowerShell single quotes', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    clearShellEnv()
    process.env.PROMPT = '$P$G'

    expect(quoteCliCommandArgument('path:C:/work/$review')).toBe('"path:C:/work/$review"')
    expect(quoteCliCommandArgument("C:/it's `n $(x)")).toBe('"C:/it\'s `n $(x)"')
    expect(quoteCliCommandArgument('{"a": 1}')).toBe('"{""a"": 1}"')
    expect(quoteCliCommandArgument('{"a":1}')).toBe('"{\\"a\\":1}"')
    expect(quoteCliCommandArgument('C:/%USER%/x')).toBe('"C:/"^%"USER"^%"/x"')
  })

  it('keeps PowerShell variables and escapes literal when running in PowerShell', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    clearShellEnv()

    expect(quoteCliCommandArgument('path:C:/work/$review')).toBe("'path:C:/work/$review'")
    expect(quoteCliCommandArgument("C:/it's `n $(x)")).toBe("'C:/it''s `n $(x)'")
    expect(quoteCliCommandArgument('path:C:/$x&whoami&rem')).toBe('"path:C:/$x&whoami&rem"')
    expect(quoteCliCommandArgument('{"a": 1}')).toBe(`'{"a": 1}'`)
  })

  it('uses POSIX quoting in Git Bash on Windows', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    clearShellEnv()
    process.env.MSYSTEM = 'MINGW64'

    expect(quoteCliCommandArgument('path:C:/work/$review')).toBe("'path:C:/work/$review'")
    expect(quoteCliCommandArgument("C:/it's `n $(x)")).toBe(`'C:/it'\\''s \`n $(x)'`)
  })
})
