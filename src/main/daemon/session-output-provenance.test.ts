import { describe, expect, it } from 'vitest'
import { SessionOutputPlane } from './session-output-plane'
import { PROCESS_BOUNDARY_GROUND } from '../../shared/terminal-mode-reset-profiles'
import type { TerminalTransientObservation } from '../../shared/terminal-transient-observation'

describe('physical terminal output provenance', () => {
  it('keeps genuine D/A across synthetic repair and delayed DA release for every held prefix', () => {
    for (const prefix of ['', '\x1b', '\x1b[', '\x1b[0']) {
      for (const terminator of ['\x07', '\x1b\\']) {
        const output = new SessionOutputPlane({ cols: 80, rows: 24, incarnationId: 'physical' })
        const facts: TerminalTransientObservation[] = []
        const display: string[] = []
        let rawEndSeq = 0
        const emit = (data: string, genuinePrefixLength = data.length): void => {
          const rawStartSeq = rawEndSeq
          rawEndSeq += genuinePrefixLength
          output.emit({ data, rawStartSeq, rawEndSeq, transformed: true }, genuinePrefixLength)
        }
        try {
          output.installDeviceAttributesFilter()
          output.attachClient({
            onData: (data) => display.push(data),
            onExit: () => {},
            transients: { install: () => {}, stage: (fact) => facts.push(fact), commit: () => {} }
          })
          emit(prefix)
          const done = `\x1b]133;D;0${terminator}`
          emit(`${done}${PROCESS_BOUNDARY_GROUND}`, done.length)
          const finishSeq = prefix ? rawEndSeq : undefined
          expect(facts).toHaveLength(prefix ? 1 : 0)
          emit('\x1b')
          output.releaseDeviceAttributesFilter()
          emit(`]133;A${terminator}`)
          expect(facts).toEqual([
            {
              kind: 'observation',
              revision: 1,
              rawEndSeq: finishSeq ?? rawEndSeq,
              fact: { kind: 'command-finished', exitCode: 0 }
            }
          ])
          expect(display.join('')).toBe(
            `${prefix}${done}${PROCESS_BOUNDARY_GROUND}\x1b]133;A${terminator}`
          )
        } finally {
          output.markDisposed()
          output.disposeEmulator()
        }
      }
    }
  })
})
