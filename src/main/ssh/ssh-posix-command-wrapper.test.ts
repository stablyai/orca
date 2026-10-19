import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import {
  REMOTE_COMMAND_DECODER_UNAVAILABLE,
  REMOTE_COMMAND_DECODER_UNAVAILABLE_EXIT,
  wrapRemoteCommandForPosixShell
} from './ssh-posix-command-wrapper'

/** A PATH directory whose tools shadow the host's. */
function shimDir(tools: Record<string, string>): string {
  const bin = mkdtempSync(join(tmpdir(), 'orca-wrapper-shims-'))
  for (const [name, script] of Object.entries(tools)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  return bin
}

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

  it('measures the compression threshold in UTF-8 bytes', () => {
    const command = `: #${'☃'.repeat(3_000)}`
    const wrapped = wrapRemoteCommandForPosixShell(command)

    expect(command.length).toBeLessThan(8_000)
    expect(Buffer.byteLength(command)).toBeGreaterThan(8_000)
    expect(Buffer.byteLength(wrapped)).toBeLessThan(8_000)
    expect(wrapped).not.toContain('\n')
  })

  it('keeps the printf form when compression would make the request larger', () => {
    const alphabet = Array.from({ length: 95 }, (_, i) => String.fromCharCode(i + 32))
      .filter((character) => !['!', "'", '\\'].includes(character))
      .join('')
    const padding = Array.from({ length: 400 }, (_, i) =>
      Array.from(
        createHash('sha256').update(String(i)).digest(),
        (byte) => alphabet[byte % alphabet.length]
      ).join('')
    ).join('')
    const wrapped = wrapRemoteCommandForPosixShell(`: #${padding}`)

    expect(wrapped).toContain('printf %b "$@"')
    expect(wrapped).not.toContain('base64')
  })

  it.skipIf(process.platform === 'win32')(
    'reconstructs multiline UTF-8 and shell metacharacters exactly',
    () => {
      const expected = "line one\nline 'two' \"$`\\ ! ☃\n"
      const command = `printf '%s' ${quotePosixShell(expected)}`
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

  it.skipIf(process.platform === 'win32')(
    'passes a long command through a gateway with a 10 KiB exec limit without consuming stdin',
    () => {
      const expected = "line '$`\\ ! ☃\n".repeat(1_000)
      const command = `printf '%s' ${quotePosixShell(expected)}\ncat\nprintf 'diagnostic' >&2\nexit 17`
      const wrapped = wrapRemoteCommandForPosixShell(command)
      // Gateways can silently truncate the exec request before the login shell sees it.
      const forwarded = Buffer.from(wrapped)
        .subarray(0, 10 * 1_024)
        .toString()
      const result = spawnSync('/bin/sh', ['-c', forwarded], {
        encoding: 'utf8',
        input: 'relay-frame\n'
      })

      expect(result.stdout).toBe(`${expected}relay-frame\n`)
      expect(result.stderr).toBe('diagnostic')
      expect(result.status).toBe(17)
    }
  )

  it.skipIf(process.platform === 'win32')('preserves trailing newlines in a long command', () => {
    const command = `# ${'padding'.repeat(2_000)}\nprintf '%s' trailing\\\n`
    const result = runThroughShell('/bin/sh', command)

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe('trailing')
  })

  it.skipIf(process.platform === 'win32')(
    'reports a host without the decoders before running anything',
    () => {
      const command = `# ${'padding'.repeat(2_000)}\nprintf 'must not run'`
      const result = spawnSync('/bin/sh', ['-c', wrapRemoteCommandForPosixShell(command)], {
        encoding: 'utf8',
        env: { ...process.env, PATH: '' }
      })

      expect(result.status).toBe(REMOTE_COMMAND_DECODER_UNAVAILABLE_EXIT)
      expect(result.stderr).toContain(REMOTE_COMMAND_DECODER_UNAVAILABLE)
      expect(result.stdout).toBe('')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'fails without running the script if the payload does not decode',
    () => {
      const bin = shimDir({ base64: "cat >/dev/null; printf 'not gzip'" })
      const command = `# ${'padding'.repeat(2_000)}\nprintf 'must not run'`
      const result = spawnSync('/bin/sh', ['-c', wrapRemoteCommandForPosixShell(command)], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }
      })

      expect(result.status).not.toBe(0)
      expect(result.stdout).toBe('')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'decodes with `base64 -D` where `-d` is refused, as on macOS before 13',
    () => {
      const real = spawnSync('/bin/sh', ['-c', 'command -v base64'], { encoding: 'utf8' })
      const bin = shimDir({
        base64: `[ "$1" = -D ] || { echo "base64: invalid option -- d" >&2; exit 64; }; exec ${real.stdout.trim()} -d`
      })
      const command = `# ${'padding'.repeat(2_000)}\nprintf 'ran'`
      const result = spawnSync('/bin/sh', ['-c', wrapRemoteCommandForPosixShell(command)], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }
      })

      expect(result.stdout).toBe('ran')
      expect(result.status).toBe(0)
    }
  )

  it('sends a long command plain when asked to', () => {
    const wrapped = wrapRemoteCommandForPosixShell(`# ${'padding'.repeat(2_000)}`, {
      compress: false
    })
    expect(wrapped).toContain('printf %b "$@"')
    expect(wrapped).not.toContain('base64')
  })

  it.skipIf(process.platform === 'win32' || !existsSync('/bin/tcsh'))(
    'keeps every login-shell word bounded for long metacharacter-heavy commands',
    () => {
      const expected = '$"`'.repeat(2_000)
      const command = `printf '%s' ${quotePosixShell(expected)}`
      const result = runThroughShell('/bin/tcsh', command)

      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toBe(expected)
    }
  )

  it.skipIf(process.platform === 'win32' || !existsSync('/bin/tcsh'))(
    'bounds login-shell words when the compressed payload spans multiple chunks',
    () => {
      const expected = Array.from({ length: 200 }, (_, i) =>
        createHash('sha256').update(String(i)).digest('hex')
      ).join('')
      const command = `printf '%s' ${quotePosixShell(expected)}`
      const wrapped = wrapRemoteCommandForPosixShell(command)
      expect(Buffer.byteLength(wrapped)).toBeLessThan(Buffer.byteLength(command))
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
    it.skipIf(process.platform === 'win32' || !existsSync(shell)).each([1, 1_000])(
      `survives the real ${shell} parser with %i repetitions`,
      (repetitions) => {
        const expected = "first\nsecond '$`\\n\\\\ ! ☃\n".repeat(repetitions)
        const command = `printf '%s' ${quotePosixShell(expected)}`
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
