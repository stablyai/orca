import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wrapPosixHookCommand } from '../agent-hooks/posix-hook-command'
import {
  getJcodeManagedCommand,
  getJcodeRemoteManagedCommand,
  isJcodeManagedCommand
} from './hook-settings'

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

afterEach(() => vi.restoreAllMocks())

const posixPaths = [
  '/home/me/.orca/agent-hooks/jcode-hook.sh',
  '/Users/First Last/.orca/agent-hooks/jcode-hook.sh',
  "/Users/o'brien/.orca/agent-hooks/jcode-hook.sh",
  '/Users/quote"odd/.orca/agent-hooks/jcode-hook.sh'
]
const windowsPaths = [
  'C:\\Users\\me\\.orca\\agent-hooks\\jcode-hook.cmd',
  'C:\\Users\\First Last\\.orca\\agent-hooks\\jcode-hook.cmd'
]

describe('jcode managed hook command quoting', () => {
  it.each(posixPaths)('runs %s through the missing-script guard as one argv', (scriptPath) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const guarded = ['/bin/sh', '-c', wrapPosixHookCommand(scriptPath)]
    expect(tokenizeLikeJcode(getJcodeManagedCommand(scriptPath))).toEqual(guarded)
    expect(tokenizeLikeJcode(getJcodeRemoteManagedCommand(scriptPath))).toEqual(guarded)
  })

  it.each(windowsPaths)('keeps a Windows script %s as one quoted argument', (scriptPath) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    expect(tokenizeLikeJcode(getJcodeManagedCommand(scriptPath))).toEqual([scriptPath])
  })

  it('is what a bare path fails to do, which is why the quoting exists', () => {
    // Unquoted Windows separators are consumed as escapes before direct execution.
    expect(tokenizeLikeJcode('C:\\Users\\me\\.orca\\agent-hooks\\jcode-hook.cmd')).toEqual([
      'C:Usersme.orcaagent-hooksjcode-hook.cmd'
    ])
  })

  it('still recognizes its own managed entry on every platform form', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    for (const scriptPath of posixPaths) {
      expect(isJcodeManagedCommand(getJcodeManagedCommand(scriptPath))).toBe(true)
      expect(isJcodeManagedCommand(getJcodeRemoteManagedCommand(scriptPath))).toBe(true)
    }
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    for (const scriptPath of windowsPaths) {
      expect(isJcodeManagedCommand(getJcodeManagedCommand(scriptPath))).toBe(true)
    }
    expect(isJcodeManagedCommand("'/home/me/.config/my-own-hook.sh'")).toBe(false)
  })
})

describe.runIf(process.platform !== 'win32')('jcode managed hook argv as jcode runs it', () => {
  function runAsJcode(scriptPath: string, input: string): void {
    const [program, ...args] = tokenizeLikeJcode(getJcodeRemoteManagedCommand(scriptPath))
    execFileSync(program, args, { input, timeout: 10_000 })
  }

  it('is a silent no-op that drains stdin once the script is removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca jcode missing '))
    try {
      // Returning proves the guard drained a payload larger than the pipe buffer.
      expect(() =>
        runAsJcode(join(dir, 'agent-hooks', 'jcode-hook.sh'), 'y'.repeat(512 * 1024))
      ).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs the script when it is present', () => {
    const dir = mkdtempSync(join(tmpdir(), "orca jcode o'brien "))
    try {
      const marker = join(dir, 'ran')
      const scriptPath = join(dir, 'jcode-hook.sh')
      writeFileSync(scriptPath, `#!/bin/sh\ncat > '${marker.replaceAll("'", "'\\''")}'\n`)
      chmodSync(scriptPath, 0o755)
      runAsJcode(scriptPath, '{"event":"turn_end"}')
      expect(existsSync(marker)).toBe(true)
      expect(readFileSync(marker, 'utf8')).toBe('{"event":"turn_end"}')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
