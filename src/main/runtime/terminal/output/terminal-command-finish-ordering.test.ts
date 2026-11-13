import { expect, it } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { TerminalSideEffectFact } from '../../../../shared/terminal/output/terminal-side-effect-facts'

it('keeps a shell completion before later facts in the same byte chunk', () => {
  const runtime = new OrcaRuntimeService(null)
  const facts: TerminalSideEffectFact[] = []
  const stop = runtime.onClientEvent((event) => {
    if (event.type === 'terminalSideEffects') {
      facts.push(...event.batch.facts)
    }
  })
  runtime.onPtyData('pty', '\x1b]133;D;7\x07\x07', 1)
  expect(facts).toEqual([{ kind: 'command-finished', exitCode: 7 }, { kind: 'bell' }])
  stop()
})

it('publishes a daemon completion before returning to its next fact', () => {
  const runtime = new OrcaRuntimeService(null)
  const facts: TerminalSideEffectFact[] = []
  const stop = runtime.onClientEvent((event) => {
    if (event.type === 'terminalSideEffects') {
      facts.push(...event.batch.facts)
    }
  })
  runtime.emitDaemonPtyTransientFact('pty', { kind: 'command-finished', exitCode: 7 })
  runtime.emitDaemonPtyTransientFact('pty', { kind: 'bell' })
  expect(facts).toEqual([{ kind: 'command-finished', exitCode: 7 }, { kind: 'bell' }])
  stop()
})
