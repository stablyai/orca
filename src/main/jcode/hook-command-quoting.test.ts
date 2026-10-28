import { describe, expect, it } from 'vitest'
import { getJcodeManagedCommand, isJcodeManagedCommand } from './hook-settings'

/** Mirror parse_hook_command in crates/jcode-terminal-launch/src/lib.rs: shell-style tokenization before direct execution. */
function tokenizeLikeJcode(raw: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: string | null = null
  let escaped = false
  let started = false
  for (const char of raw) {
    if (escaped) {
      current += char
      started = true
      escaped = false
    } else if (quote) {
      if (char === quote) {
        quote = null
      } else if (char === '\\' && quote === '"') {
        escaped = true
      } else {
        current += char
        started = true
      }
    } else if (char === '\\') {
      escaped = true
      started = true
    } else if (char === "'" || char === '"') {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) {
        parts.push(current)
        current = ''
        started = false
      }
    } else {
      current += char
      started = true
    }
  }
  if (started) {
    parts.push(current)
  }
  return parts
}

describe('jcode managed hook command quoting', () => {
  const paths = [
    'C:\\Users\\me\\.orca\\agent-hooks\\jcode-hook.cmd',
    'C:\\Users\\First Last\\.orca\\agent-hooks\\jcode-hook.cmd',
    '/home/me/.orca/agent-hooks/jcode-hook.sh',
    '/Users/First Last/.orca/agent-hooks/jcode-hook.sh',
    "/Users/o'brien/.orca/agent-hooks/jcode-hook.sh",
    '/Users/quote"odd/.orca/agent-hooks/jcode-hook.sh'
  ]

  it.each(paths)('survives jcode\u2019s tokenizer as one argument: %s', (scriptPath) => {
    expect(tokenizeLikeJcode(getJcodeManagedCommand(scriptPath))).toEqual([scriptPath])
  })

  it('is what a bare path fails to do, which is why the quoting exists', () => {
    // Unquoted Windows separators are consumed as escapes before direct execution.
    expect(tokenizeLikeJcode('C:\\Users\\me\\.orca\\agent-hooks\\jcode-hook.cmd')).toEqual([
      'C:Usersme.orcaagent-hooksjcode-hook.cmd'
    ])
  })

  it('still recognizes its own managed entry on either separator', () => {
    for (const scriptPath of paths) {
      expect(isJcodeManagedCommand(getJcodeManagedCommand(scriptPath))).toBe(true)
    }
    expect(isJcodeManagedCommand("'/home/me/.config/my-own-hook.sh'")).toBe(false)
  })
})
