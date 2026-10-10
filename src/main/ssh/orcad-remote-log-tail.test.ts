import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import {
  ORCAD_LOG_TAIL_LINES,
  ORCAD_LOG_TAIL_MAX_BYTES,
  orcadLogTailCommand,
  parseOrcadLogTail,
  withOrcadLogTail
} from './orcad-remote-log-tail'
import { ORCAD_WINDOWS_HOST_SCRIPT } from './orcad-windows-host-script'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const execCommand = vi.hoisted(() => vi.fn())
vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand }))

const linux = getRemoteHostPlatform('linux-x64')
const windows = getRemoteHostPlatform('win32-x64')
const SLOT = '/home/me/.orca-remote/orcad-1.0.0'
const WINDOWS_SLOT = 'C:\\Users\\me\\.orca-remote\\orcad-1.0.0'
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand is mocked; the connection is never used.
const conn = {} as never

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orcad-log-tail-'))
  execCommand.mockReset()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n')
}

describe('orcad.log tail', () => {
  it('keeps only the last lines and bytes, redacting secrets', () => {
    const tail = parseOrcadLogTail(linux, `${numberedLines(100)}\ntoken=abc123secret\n`)
    const lines = (tail ?? '').split('\n')
    expect(lines).toHaveLength(ORCAD_LOG_TAIL_LINES)
    expect(lines[0]).toBe('line 62')
    expect(tail).not.toContain('abc123secret')
    expect(tail).toContain('[redacted')

    const huge = parseOrcadLogTail(linux, 'x'.repeat(ORCAD_LOG_TAIL_MAX_BYTES * 4))
    expect(Buffer.byteLength(huge ?? '', 'utf8')).toBeLessThanOrEqual(ORCAD_LOG_TAIL_MAX_BYTES)
    expect(parseOrcadLogTail(linux, '  \n')).toBeNull()
  })

  it('reads the log on Windows through the node.exe host script, never an encoded command', () => {
    const command = orcadLogTailCommand(windows, WINDOWS_SLOT)
    expect(command).toContain('node.exe')
    expect(command).toContain(' log-tail ')
    expect(command).not.toMatch(/EncodedCommand/iu)
  })

  it.skipIf(process.platform === 'win32')(
    'runs the POSIX command against a real file',
    async () => {
      const slot = join(dir, 'slot')
      mkdirSync(slot)
      writeFileSync(join(slot, 'orcad.log'), `${numberedLines(60)}\n`)
      const run = await runProcess({
        program: '/bin/sh',
        args: ['-c', orcadLogTailCommand(linux, slot)],
        timeoutMs: 5_000
      })
      expect(parseOrcadLogTail(linux, run.stdout)?.split('\n').at(-1)).toBe('line 60')
      const missing = await runProcess({
        program: '/bin/sh',
        args: ['-c', orcadLogTailCommand(linux, join(dir, 'absent'))],
        timeoutMs: 5_000
      })
      expect(parseOrcadLogTail(linux, missing.stdout)).toBeNull()
    }
  )

  it('reads the end of the log through the real Windows host script op', async () => {
    const script = join(dir, 'host-script.js')
    writeFileSync(script, ORCAD_WINDOWS_HOST_SCRIPT)
    const log = join(dir, 'orcad.log')
    writeFileSync(log, `${'y'.repeat(ORCAD_LOG_TAIL_MAX_BYTES * 2)}\nfatal: bind failed\n`)
    const run = await runProcess({
      program: process.execPath,
      args: [script, 'log-tail', log, String(ORCAD_LOG_TAIL_MAX_BYTES)],
      timeoutMs: 15_000
    })
    const tail = parseOrcadLogTail(windows, run.stdout)
    expect(tail?.endsWith('fatal: bind failed')).toBe(true)
    const absent = await runProcess({
      program: process.execPath,
      args: [script, 'log-tail', join(dir, 'absent.log'), '100'],
      timeoutMs: 15_000
    })
    expect(parseOrcadLogTail(windows, absent.stdout)).toBeNull()
  })

  it('appends the tail to a failure message, and leaves it alone when the host cannot answer', async () => {
    execCommand.mockResolvedValueOnce('starting\nError: EADDRINUSE\n')
    await expect(withOrcadLogTail({ conn, host: linux }, SLOT, 'Launch failed.')).resolves.toBe(
      'Launch failed.\nLast lines of orcad.log:\nstarting\nError: EADDRINUSE'
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    execCommand.mockRejectedValueOnce(new Error('Connection lost'))
    await expect(withOrcadLogTail({ conn, host: linux }, SLOT, 'Launch failed.')).resolves.toBe(
      'Launch failed.'
    )
    warn.mockRestore()
  })
})
