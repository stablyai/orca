import { PassThrough } from 'node:stream'
import { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPairingRedactor,
  PAIRING_HIDDEN_LINE,
  redactingSpawn,
  shouldRedactSupervisedStdout
} from './serve-pairing-redaction'

const READY = [
  'Orca server ready',
  'Bound endpoint: ws://0.0.0.0:6768',
  'Web client URL: https://host/web#pairing=secret',
  'Mobile pairing QR:',
  '█▀▀▀▀▀█ secret-qr',
  '█ ███ █',
  'Pairing URL: orca://pair?code=secret',
  '[serve] later log line'
]

describe('supervised pairing redaction', () => {
  afterEach(() => vi.restoreAllMocks())

  it('drops every line that carries the offer and keeps the rest', () => {
    const redact = createPairingRedactor()
    const kept = READY.map(redact).filter((line) => line !== null)
    expect(kept).toEqual([
      'Orca server ready',
      'Bound endpoint: ws://0.0.0.0:6768',
      PAIRING_HIDDEN_LINE,
      '[serve] later log line'
    ])
    expect(kept.join('\n')).not.toContain('secret')
  })

  it('blanks the pairing offer in the JSON readiness line', () => {
    const line = JSON.stringify({
      type: 'orca_server_ready',
      endpoint: 'ws://x',
      pairing: { available: true, url: 'orca://pair?code=secret' }
    })
    const kept = createPairingRedactor()(line)
    expect(kept).not.toContain('secret')
    expect(JSON.parse(kept ?? '{}')).toMatchObject({
      endpoint: 'ws://x',
      pairing: { available: false }
    })
  })

  it('redacts only supervised output that is not a terminal', () => {
    expect(shouldRedactSupervisedStdout(true, false)).toBe(true)
    expect(shouldRedactSupervisedStdout(true, true)).toBe(false)
    expect(shouldRedactSupervisedStdout(false, false)).toBe(false)
  })

  it('pipes only stdout through the redactor and keeps the ipc slot', async () => {
    const stdout = new PassThrough()
    const child = new ChildProcess()
    child.stdout = stdout
    const spawn = vi.fn((): ChildProcess => child)
    const written: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })
    redactingSpawn(spawn)({ program: 'orca', stdio: ['inherit', 'inherit', 'inherit', 'ipc'] })
    expect(spawn).toHaveBeenCalledWith({
      program: 'orca',
      stdio: ['inherit', 'pipe', 'inherit', 'ipc']
    })
    stdout.end(`${READY.join('\n')}\n`)
    await vi.waitFor(() => expect(written.join('')).toContain('later log line'))
    expect(written.join('')).not.toContain('secret')
  })
})
