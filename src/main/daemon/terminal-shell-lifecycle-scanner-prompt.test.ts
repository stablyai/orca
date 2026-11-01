import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TerminalShellLifecycleScanner } from './terminal-shell-lifecycle-scanner'
import { PtyShellOwnershipMirror } from '../runtime/pty-shell-ownership-mirror'

const A = '\x1b]133;A\x07'
const B = '\x1b]133;B\x07'
const C = '\x1b]133;C\x07'
const D0 = '\x1b]133;D;0\x07'
const D1 = '\x1b]133;D;1\x07'
// Captured agent CLI PTY bytes: each bubble paints its own `A … B C D;0` zone while the app runs (#10923).
const APP_ZONE_TRANSCRIPT = readFileSync(
  join(__dirname, '../runtime/__fixtures__/omp-user-bubble-osc133-zone.txt'),
  'utf8'
)
// Orca's bash wrapper bytes: prompt, typed command echo, C, output, D;exit, next prompt.
const shellRuns = (command: string, output: string, end = D0): string =>
  `${A}$ ${B}${command}\r\n${C}${output}\r\n${end}`
const PROMPT = `${A}$ ${B}`
// An agent TUI painting a bubble with output between its C and D, as no adjacency rule can catch.
const APP_BUBBLE = `${A}> ${B}hi${C}thinking…\r\n${D0}${A}> `

function idleAfter(...chunks: string[]): boolean {
  const scanner = new TerminalShellLifecycleScanner()
  for (const chunk of chunks) {
    scanner.scan(chunk)
  }
  return scanner.isIdleAtPrompt
}

describe('idle at a shell prompt', () => {
  it('is idle once a prompt follows a cleanly finished command', () => {
    expect(idleAfter(shellRuns('ls', 'file') + PROMPT)).toBe(true)
  })

  it('is idle when the markers split across chunks', () => {
    const bytes = shellRuns('ls', 'file') + PROMPT
    expect(idleAfter(...bytes.split(''))).toBe(true)
  })

  it('does not trust a first prompt before the shell has shown it marks command starts', () => {
    expect(idleAfter(PROMPT)).toBe(false)
  })

  it('is not idle while a command runs, before its prompt returns, or after a failed command', () => {
    expect(idleAfter(`${PROMPT}sleep 9\r\n${C}`)).toBe(false)
    expect(idleAfter(shellRuns('ls', 'file'))).toBe(false)
    expect(idleAfter(shellRuns('false', '', D1) + PROMPT)).toBe(false)
  })

  it('is not idle without shell integration', () => {
    expect(idleAfter('user@host:~$ ls\r\nfile\r\nuser@host:~$ ')).toBe(false)
  })

  it('is not idle on the alternate screen or after a full reset', () => {
    const idle = shellRuns('ls', 'file') + PROMPT
    expect(idleAfter(idle, '\x1b[?1049h')).toBe(false)
    expect(idleAfter(idle, '\x1bc')).toBe(false)
  })

  // Review case 1: a mirror seeded or created mid-session must not read an agent's own A as a prompt.
  it("does not read a running agent's prompt marker as idle after a seed or a late start", () => {
    const scanner = new TerminalShellLifecycleScanner()
    scanner.scan(shellRuns('ls', 'file') + PROMPT)
    scanner.seedOwner(undefined)
    expect(scanner.isIdleAtPrompt).toBe(false)
    scanner.scan(`${A}> `)
    expect(scanner.isIdleAtPrompt).toBe(false)
    expect(idleAfter(`agent output\r\n${A}> `)).toBe(false)
  })

  // Review case 2: a prompt-only integration never marks the agent the user typed.
  it('stays not idle when the integration paints prompts but never command starts', () => {
    expect(idleAfter(PROMPT, 'claude\r\n', 'agent ui', `${A}> `)).toBe(false)
    expect(idleAfter(`${PROMPT}ls\r\nfile\r\n${PROMPT}`)).toBe(false)
  })

  // Review case 3: an app's zones inside the shell's command never close that command.
  it.each([
    ['captured adjacent B C D;0 zones', APP_ZONE_TRANSCRIPT],
    ['output between the app C and D', APP_BUBBLE],
    ['a nonzero app D', `${A}> ${B}${C}err\r\n${D1}${A}> `],
    ['a lone app C and D', `${C}out\r\n${D0}${A}> `]
  ])("ignores an app's %s while the shell's command runs", (_name, app) => {
    expect(idleAfter(`${PROMPT}agent\r\n${C}`, app)).toBe(false)
    expect(idleAfter(`${PROMPT}agent\r\n${C}`, app, app)).toBe(false)
  })

  // Review case 4: one prompt admits one fast submit; the next needs a fresh prompt.
  it('admits one claim per prompt cycle', () => {
    const mirror = new PtyShellOwnershipMirror(async () => false)
    mirror.scan(shellRuns('ls', 'file') + PROMPT)
    expect(mirror.claimIdlePrompt()).toBe(true)
    expect(mirror.claimIdlePrompt()).toBe(false)
    mirror.scan(`claude\r\n${PROMPT}`)
    expect(mirror.claimIdlePrompt()).toBe(false)
    mirror.scan(shellRuns('pwd', '/tmp') + PROMPT)
    expect(mirror.claimIdlePrompt()).toBe(true)
  })
})
