import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { TerminalShellLifecycleScanner } from './terminal-shell-lifecycle-scanner'
import { TerminalShellRecoveryBarrier } from './terminal-shell-recovery-barrier'

// Real OMP 18.10.3 PTY bytes for one prompt: each user bubble ends with `B C D;0` (#10923).
const OMP_TRANSCRIPT = readFileSync(
  join(__dirname, '../runtime/__fixtures__/omp-user-bubble-osc133-zone.txt'),
  'utf8'
)
const A = '\x1b]133;A\x07'
const B = '\x1b]133;B\x07'
const C = '\x1b]133;C\x07'
const D0 = '\x1b]133;D;0\x07'
const SHELL_LAUNCH = `${A}$ ${B}omp\r\n${C}`
const ARM_MODIFY_OTHER_KEYS = '\x1b[>4;2m'

function triggers(chunks: string[]): number[] {
  const scanner = new TerminalShellLifecycleScanner()
  const ends: number[] = []
  let offset = 0
  for (const chunk of chunks) {
    let rest = chunk
    let restOffset = offset
    while (rest.length > 0) {
      const events = scanner.scan(rest)
      if (events.uncleanDeathTriggerEnd === undefined) {
        break
      }
      ends.push(restOffset + events.uncleanDeathTriggerEnd)
      restOffset += events.uncleanDeathTriggerEnd
      rest = rest.slice(events.uncleanDeathTriggerEnd)
    }
    offset += chunk.length
  }
  return ends
}

function splitEvery(text: string, size: number): string[] {
  const chunks: string[] = []
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size))
  }
  return chunks
}

describe('an OSC 133 zone a running app closes for itself', () => {
  it.each([1, 3, 7, 64, SHELL_LAUNCH.length + OMP_TRANSCRIPT.length])(
    "does not read OMP's bubble markers as its death, in %i-char chunks",
    (size) => {
      expect(triggers(splitEvery(SHELL_LAUNCH + OMP_TRANSCRIPT, size))).toEqual([])
    }
  )

  it('still repairs after the app dies with its input mode armed', () => {
    const stream = `${SHELL_LAUNCH}${ARM_MODIFY_OTHER_KEYS}${OMP_TRANSCRIPT}Killed\r\n${D0}`
    expect(triggers([stream])).toEqual([stream.length])
  })

  it.each([
    ['output separates the C from the D', `${B}${C}x${D0}`],
    ['the typed command separates the B from the C', `${B}ls\r\n${C}${D0}`],
    ['the D reports a failure', `${B}${C}\x1b]133;D;1\x07`]
  ])('still reads a D as the end of the command when %s', (_label, zone) => {
    const stream = `${SHELL_LAUNCH}${ARM_MODIFY_OTHER_KEYS}${zone}`
    expect(triggers([stream])).toEqual([stream.length])
  })

  it('passes OMP output through the recovery barrier without holding it for a process probe', () => {
    const released: string[] = []
    const confirmShellForeground = vi.fn(async () => false)
    const barrier = new TerminalShellRecoveryBarrier({
      confirmShellForeground,
      release: (emission) => released.push(emission.data),
      isAlive: () => true
    })
    let seq = 0
    for (const data of splitEvery(SHELL_LAUNCH + OMP_TRANSCRIPT, 4096)) {
      barrier.accept({ data, rawStartSeq: seq, rawEndSeq: seq + data.length, transformed: false })
      seq += data.length
    }
    expect(confirmShellForeground).not.toHaveBeenCalled()
    expect(released.join('')).toBe(SHELL_LAUNCH + OMP_TRANSCRIPT)
    barrier.dispose()
  })
})
