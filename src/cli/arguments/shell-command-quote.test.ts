import { afterEach, describe, expect, it, vi } from 'vitest'
import { quoteCliCommandArgument } from './shell-command-quote'

describe('quoteCliCommandArgument on Windows', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps PowerShell variables and escapes literal', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    expect(quoteCliCommandArgument('path:C:/work/$review')).toBe("'path:C:/work/$review'")
    expect(quoteCliCommandArgument("C:/it's `n $(x)")).toBe("'C:/it''s `n $(x)'")
    expect(quoteCliCommandArgument('path:C:/$x&whoami&rem')).toBe('"path:C:/$x&whoami&rem"')
    expect(quoteCliCommandArgument('{"a": 1}')).toBe(`'{"a": 1}'`)
    expect(quoteCliCommandArgument('path:C:/my work')).toBe('"path:C:/my work"')
  })
})
