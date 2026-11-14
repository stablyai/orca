import { describe, expect, it, vi } from 'vitest'
import './bind-first-pane.test-fixture'
import './runtime-test-module-registration.spec'
import '../orca-runtime'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import { syncSinglePty } from './orca-runtime-test-fixtures.spec'
import { createSideEffectRuntime } from './orca-runtime-test-scenario-builders.spec'
import { DECORATIVE_TITLE_FACT_HEARTBEAT_MS } from '../terminal/output/decorative-title-fact-emission'

describe('terminal side-effect fact channel', () => {
  it('bounds decorative title delivery per paired client below the local heartbeat', () => {
    // Clear the local heartbeat each round so only the per-client gate can collapse repeats.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { runtime, batches } = createSideEffectRuntime()
      const firstClientEvents: RuntimeClientEvent[] = []
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      runtime.onClientEvent((event) => firstClientEvents.push(event))

      const ptyIds = Array.from({ length: 64 }, (_, index) => `pty-remote-${index}`)
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
      const stepPastHeartbeat = (): void => {
        vi.setSystemTime(new Date(Date.now() + DECORATIVE_TITLE_FACT_HEARTBEAT_MS))
      }
      for (const ptyId of ptyIds) {
        runtime.ingestSyntheticTitleFrame(ptyId, `\x1b]0;${frames[0]} Cursor Agent\x07`)
      }
      firstClientEvents.length = 0

      for (const frame of frames.slice(1)) {
        stepPastHeartbeat()
        for (const ptyId of ptyIds) {
          runtime.ingestSyntheticTitleFrame(ptyId, `\x1b]0;${frame} Cursor Agent\x07`)
        }
      }

      expect(firstClientEvents).toEqual([])
      expect(batches).toHaveLength(ptyIds.length * frames.length)

      const bellChunk = `\x1b]0;${frames.at(-1)} Cursor Agent\x07\x07`
      runtime.onPtyData(ptyIds[0], bellChunk, 1)
      expect(firstClientEvents).toEqual([
        expect.objectContaining({
          type: 'terminalSideEffects',
          batch: expect.objectContaining({ facts: [{ kind: 'bell' }] })
        })
      ])
      firstClientEvents.length = 0

      const secondClientEvents: RuntimeClientEvent[] = []
      runtime.onClientEvent((event) => secondClientEvents.push(event))
      stepPastHeartbeat()
      for (const ptyId of ptyIds) {
        runtime.ingestSyntheticTitleFrame(ptyId, `\x1b]0;${frames[0]} Cursor Agent\x07`)
      }

      expect(firstClientEvents).toEqual([])
      expect(secondClientEvents).toHaveLength(ptyIds.length)

      for (const ptyId of ptyIds) {
        runtime.ingestSyntheticTitleFrame(ptyId, '\x1b]0;Cursor ready\x07')
      }
      expect(firstClientEvents).toHaveLength(ptyIds.length)
      expect(secondClientEvents).toHaveLength(ptyIds.length * 2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not confirm an agent exit from a foreground read predating its title', async () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)
    let resolveStaleRead!: (process: string) => void
    const staleRead = new Promise<string>((resolve) => {
      resolveStaleRead = resolve
    })
    const getForegroundProcess = vi.fn().mockReturnValueOnce(staleRead).mockResolvedValueOnce('zsh')
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })

    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;Codex ready\x07')
    runtime.onPtyData('pty-1', '\x1b]0;bichir\x07', 100)
    expect(getForegroundProcess).toHaveBeenCalledOnce()

    resolveStaleRead('codex')

    await vi.waitFor(() => expect(getForegroundProcess).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(batches.flatMap((batch) => batch.facts)).toContainEqual({ kind: 'agent-exited' })
    )
  })

  it('aligns a restored session and pre-response bytes to the provider sequence', async () => {
    const { runtime } = createSideEffectRuntime()

    // Simulate a stream-socket byte winning the race with the spawn response.
    runtime.onPtyData('pty-restored', 'queued', 100)
    expect(
      runtime.synchronizePtyOutputSequenceFromProvider(
        'pty-restored',
        { value: 900, generation: 'continued' },
        0
      )
    ).toBe(906)
    runtime.onPtyData('pty-restored', 'fresh', 101)

    expect(runtime.getPtyOutputSequence('pty-restored')).toBe(911)
    await expect(runtime.serializeMainTerminalBuffer('pty-restored')).resolves.toMatchObject({
      data: expect.stringContaining('queuedfresh'),
      seq: 911,
      source: 'headless'
    })
  })

  it('drops stale headless state without rewinding the runtime sequence', async () => {
    const { runtime } = createSideEffectRuntime()
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-restarted',
      { value: 0, generation: 'reset' },
      0
    )
    runtime.onPtyData('pty-restarted', 'old generation', 100)
    const sequenceBeforeRespawn = runtime.getPtyOutputSequence('pty-restarted')

    expect(
      runtime.synchronizePtyOutputSequenceFromProvider(
        'pty-restarted',
        { value: 0, generation: 'reset' },
        sequenceBeforeRespawn
      )
    ).toBe(sequenceBeforeRespawn)
    runtime.onPtyData('pty-restarted', 'new generation', 101)

    await expect(runtime.serializeMainTerminalBuffer('pty-restarted')).resolves.toMatchObject({
      data: expect.not.stringContaining('old generation'),
      seq: sequenceBeforeRespawn + 'new generation'.length
    })
  })

  it('keeps active listener sequences monotonic across a daemon reset', () => {
    const { runtime } = createSideEffectRuntime()
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-reset',
      { value: 0, generation: 'reset' },
      0
    )
    runtime.onPtyData('pty-reset', 'old', 100)
    const sequenceBeforeRespawn = runtime.getPtyOutputSequence('pty-reset')
    const observedSequences: number[] = []
    runtime.subscribeToTerminalData('pty-reset', (_data, meta) => {
      if (typeof meta?.seq === 'number') {
        observedSequences.push(meta.seq)
      }
    })

    runtime.onPtyData('pty-reset', 'early', 101)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-reset',
      { value: 0, generation: 'reset' },
      sequenceBeforeRespawn
    )
    runtime.onPtyData('pty-reset', 'later', 102)

    expect(observedSequences).toEqual([
      sequenceBeforeRespawn + 'early'.length,
      sequenceBeforeRespawn + 'early'.length + 'later'.length
    ])
  })
})
