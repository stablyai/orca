import { encodePosixPrintfRecords } from '../../shared/posix-printf-encoding'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quotePosixShell } from '../../shared/shell/launch/shell-argument-quoting'
import {
  REMOTE_COMMAND_DECODER_UNAVAILABLE,
  REMOTE_COMMAND_DECODER_UNAVAILABLE_EXIT,
  wrapRemoteCommandForPosixShell
} from './ssh-posix-command-wrapper'

function shimDir(tools: Record<string, string>): string {
  const bin = mkdtempSync(join(tmpdir(), 'orca-wrapper-shims-'))
  for (const [name, script] of Object.entries(tools)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  return bin
}

it.skipIf(process.platform === 'win32')(
  'keeps incremental printf records byte-bounded and lossless at escape/codepoint boundaries',
  () => {
    const controls = Array.from({ length: 128 }, (_, index) => String.fromCharCode(index)).join('')
    const text = `${'x'.repeat(1023)}🌊${controls}\\c\\012\uFEFF'!%$\`\ud800`.repeat(4)
    const chunks = [...encodePosixPrintfRecords(text)]
    expect(chunks.every((chunk) => Buffer.byteLength(chunk) <= 1024)).toBe(true)
    expect(chunks.every((chunk) => !chunk.includes('\n') && !chunk.includes('\0'))).toBe(true)
    const result = spawnSync('/bin/sh', ['-c', 'printf "%b" "$@"', 'fixture', ...chunks])
    expect(result.status).toBe(0)
    expect(result.stdout).toEqual(Buffer.from(text))
    expect([...encodePosixPrintfRecords('')]).toEqual([''])
  }
)

describe('wrapRemoteCommandForPosixShell', () => {
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
})

function runThroughShell(shell: string, command: string, input?: string) {
  return spawnSync(shell, ['-c', wrapRemoteCommandForPosixShell(command)], {
    encoding: 'utf8',
    input
  })
}
