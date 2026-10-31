import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TerminalShellLifecycleScanner } from './terminal-shell-lifecycle-scanner'

const A = '\x1b]133;A\x07'
const B = '\x1b]133;B\x07'
const C = '\x1b]133;C\x07'
const D0 = '\x1b]133;D;0\x07'
// Captured agent CLI PTY bytes: each bubble paints its own `A … B C D;0` zone while the app runs (#10923).
const APP_ZONE_TRANSCRIPT = readFileSync(
  join(__dirname, '../runtime/__fixtures__/omp-user-bubble-osc133-zone.txt'),
  'utf8'
)

function idleAfter(...chunks: string[]): boolean {
  const scanner = new TerminalShellLifecycleScanner()
  for (const chunk of chunks) {
    scanner.scan(chunk)
  }
  return scanner.isIdleAtPrompt
}

describe('idle at a shell prompt', () => {
  it('is idle once a prompt follows the last command end', () => {
    expect(idleAfter(`${A}$ ${B}`)).toBe(true)
    expect(idleAfter(`${A}$ ${B}ls\r\n${C}out\r\n${D0}${A}$ ${B}`)).toBe(true)
  })

  it('is idle when the prompt marker splits across chunks', () => {
    expect(idleAfter(`${D0}\x1b]13`, `3;A\x07$ `)).toBe(true)
  })

  it('is not idle while a command runs or before its prompt returns', () => {
    expect(idleAfter(`${A}$ ${B}sleep 9\r\n${C}`)).toBe(false)
    expect(idleAfter(`${A}$ ${B}ls\r\n${C}out\r\n${D0}`)).toBe(false)
  })

  it('is not idle without shell integration', () => {
    expect(idleAfter('user@host:~$ ')).toBe(false)
  })

  it("ignores a running app's own prompt zones", () => {
    expect(idleAfter(`${A}$ ${B}agent\r\n${C}`, APP_ZONE_TRANSCRIPT, `${A}> `)).toBe(false)
  })

  it('is not idle on the alternate screen or after a full reset', () => {
    expect(idleAfter(`${A}$ `, '\x1b[?1049h')).toBe(false)
    expect(idleAfter(`${A}$ `, '\x1bc')).toBe(false)
  })

  it('forgets the prompt when restored bytes bypass the scan', () => {
    const scanner = new TerminalShellLifecycleScanner()
    scanner.scan(`${A}$ `)
    scanner.seedOwner(undefined)
    expect(scanner.isIdleAtPrompt).toBe(false)
  })
})
