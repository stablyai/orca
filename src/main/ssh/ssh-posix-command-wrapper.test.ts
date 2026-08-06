import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { shellEscape, wrapRemoteCommandForPosixShell } from './ssh-connection-utils'

describe('wrapRemoteCommandForPosixShell', () => {
  it('emits one physical line without requiring a remote decoder binary', () => {
    const wrapped = wrapRemoteCommandForPosixShell("printf 'a\\n'\nprintf 'b\\n'")
    expect(wrapped).not.toContain('\n')
    expect(wrapped).toContain('printf %b "$@"')
    expect(wrapped).not.toContain('base64')
  })

  it('does not expand long commands made only of parser-safe ASCII', () => {
    const command = `: #${'x'.repeat(7_000)}`
    expect(wrapRemoteCommandForPosixShell(command).length - command.length).toBeLessThan(200)
  })

  it('does not octal-expand literal UTF-8 near SSH command-length limits', () => {
    const command = `: #${'☃'.repeat(7_000)}`
    expect(wrapRemoteCommandForPosixShell(command).length - command.length).toBeLessThan(200)
  })

  it('does not octal-expand quoted shell metacharacters near command-length limits', () => {
    const command = `: #${'$"`'.repeat(2_000)}`
    expect(wrapRemoteCommandForPosixShell(command).length - command.length).toBeLessThan(200)
  })

  it.skipIf(process.platform === 'win32')(
    'reconstructs multiline UTF-8 and shell metacharacters exactly',
    () => {
      const expected = "line one\nline 'two' \"$`\\ ! ☃\n"
      const command = `printf '%s' ${shellEscape(expected)}`
      const result = runThroughShell('/bin/sh', command)

      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toBe(expected)
    }
  )

  it.skipIf(process.platform === 'win32')('keeps stdin free for relay protocol bytes', () => {
    const command = 'IFS= read -r frame; printf \'frame:%s\' "$frame"'
    const result = runThroughShell('/bin/sh', command, 'rpc-payload\n')

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('frame:rpc-payload')
  })

  it.skipIf(process.platform === 'win32' || !existsSync('/bin/tcsh'))(
    'keeps every login-shell word bounded for long metacharacter-heavy commands',
    () => {
      const expected = '$"`'.repeat(2_000)
      const command = `printf '%s' ${shellEscape(expected)}`
      const result = runThroughShell('/bin/tcsh', command)

      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toBe(expected)
    }
  )

  for (const shell of [
    '/bin/sh',
    '/bin/bash',
    '/bin/dash',
    '/bin/zsh',
    '/bin/ksh',
    '/bin/csh',
    '/bin/tcsh',
    '/usr/bin/fish',
    '/usr/local/bin/fish',
    '/opt/homebrew/bin/fish'
  ]) {
    it.skipIf(process.platform === 'win32' || !existsSync(shell))(
      `survives the real ${shell} parser`,
      () => {
        const expected = "first\nsecond '$`\\n\\\\ ! ☃\n"
        const command = `printf '%s' ${shellEscape(expected)}`
        const result = runThroughShell(shell, command)
        expect(result.status).toBe(0)
        expect(result.stderr).toBe('')
        expect(result.stdout).toBe(expected)
      }
    )
  }
})

function runThroughShell(shell: string, command: string, input?: string) {
  return spawnSync(shell, ['-c', wrapRemoteCommandForPosixShell(command)], {
    encoding: 'utf8',
    input
  })
}
