import { describe, expect, it } from 'vitest'
import { SessionOutputPlane } from './session-output-plane'
import { PROCESS_BOUNDARY_GROUND } from '../../shared/terminal-mode-reset-profiles'
import { TerminalSnapshotConsumption } from '../../shared/terminal-snapshot-consumption'
import type {
  TerminalTransientFact,
  TerminalTransientObservation
} from '../../shared/terminal-transient-observation'

describe('physical terminal output provenance', () => {
  it('keeps genuine D/A across synthetic repair and delayed DA release for every held prefix', () => {
    for (const prefix of ['', '\x1b', '\x1b[', '\x1b[0']) {
      for (const terminator of ['\x07', '\x1b\\']) {
        const output = new SessionOutputPlane({ cols: 80, rows: 24, incarnationId: 'physical' })
        const facts: TerminalTransientFact[] = []
        const snapshots: TerminalTransientObservation[] = []
        const staged: TerminalTransientObservation[] = []
        const order: string[] = []
        const consumption = new TerminalSnapshotConsumption()
        let installed: TerminalTransientObservation | undefined
        let readCurrent: (() => TerminalTransientObservation) | undefined
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
            onData: (data) => {
              display.push(data)
              order.push('display')
            },
            onExit: () => {},
            transients: {
              install: (current, incarnation, reader) => {
                expect(incarnation).toBe('physical')
                expect(reader()).toEqual(current)
                installed = current
                readCurrent = reader
                expect(consumption.install(current).effects).toEqual([])
              },
              stage: (current) => staged.push(current),
              commit: () => {
                order.push('effects')
                for (const current of staged.splice(0)) {
                  snapshots.push(current)
                  facts.push(
                    ...(consumption.consume(current)?.effects.map((effect) => effect.fact) ?? [])
                  )
                }
              }
            }
          })
          emit(prefix)
          const done = `\x1b]133;D;0${terminator}`
          emit(`${done}${PROCESS_BOUNDARY_GROUND}`, done.length)
          const finishSeq = prefix ? rawEndSeq : undefined
          expect(facts).toHaveLength(prefix ? 1 : 0)
          emit('\x1b')
          output.releaseDeviceAttributesFilter()
          emit(`]133;A${terminator}`)
          expect(facts).toEqual([{ kind: 'command-finished', exitCode: 0 }])
          const current = snapshots.at(-1)
          if (!current || !installed || !readCurrent) {
            throw new Error('Expected actual snapshot installation and delivery')
          }
          expect(current.rawEndSeq).toBe(finishSeq ?? rawEndSeq)
          expect(current.effects['command-finished']?.count).toBe(1)
          expect(current.current.command).toBe('prompt')
          expect(readCurrent()).toEqual({ ...current, rawEndSeq })
          expect(consumption.consumeLive(current, [])?.effects).toEqual([])
          expect(consumption.consume(installed)).toBeNull()
          const quiet = new TerminalSnapshotConsumption()
          expect(quiet.install(current).effects).toEqual([])
          expect(quiet.consumeLive(current, [])?.effects).toEqual([])
          expect(order).toEqual(display.flatMap(() => ['display', 'effects']))
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
