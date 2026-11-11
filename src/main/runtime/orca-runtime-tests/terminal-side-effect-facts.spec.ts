import { describe, expect, it, vi } from 'vitest'
import './bind-first-pane.test-fixture'
import './runtime-test-module-registration.spec'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-session-contracts'
import { OrcaRuntimeService } from '../orca-runtime'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import { TEST_WORKTREE_ID, store, syncSinglePty } from './orca-runtime-test-fixtures.spec'
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

  it('skips a listener unsubscribed mid-fan-out even with mobile exclusions active', () => {
    const runtime = new OrcaRuntimeService(store)
    const lateEvents: RuntimeClientEvent[] = []
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime.onClientEvent(() => {}, { consumesTerminalSideEffects: false })
    runtime.onClientEvent(() => {
      unsubscribeLate()
    })
    const unsubscribeLate = runtime.onClientEvent((event) => lateEvents.push(event))

    runtime.onPtyData('pty-remote', '\x1b]0;Codex working\x07', 100)

    expect(lateEvents).toEqual([])
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

  it('retains bytes emitted before a fresh daemon spawn resolves', async () => {
    const { runtime } = createSideEffectRuntime()
    const earlyOutput = '\x1b]0;Fresh shell\x07early prompt'
    runtime.onPtyData('pty-fresh', earlyOutput, 100)

    expect(
      runtime.synchronizePtyOutputSequenceFromProvider(
        'pty-fresh',
        { value: 0, generation: 'reset' },
        0
      )
    ).toBe(earlyOutput.length)

    await expect(runtime.serializeMainTerminalBuffer('pty-fresh')).resolves.toMatchObject({
      data: expect.stringContaining('early prompt'),
      lastTitle: 'Fresh shell',
      seq: earlyOutput.length
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

  it('emits command-finished facts with best-effort exit codes across chunk splits', () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)

    runtime.onPtyData('pty-1', 'output\x1b]133;D;13', 100)
    expect(batches).toEqual([])
    runtime.onPtyData('pty-1', '0\x07prompt $ ', 101)
    runtime.onPtyData('pty-1', '\x1b]133;D\x07', 102)

    expect(batches.flatMap((batch) => batch.facts)).toEqual([
      { kind: 'command-finished', exitCode: 130 },
      { kind: 'command-finished', exitCode: null }
    ])
  })

  it('emits pr-link facts once per URL with batch attribution', () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)

    runtime.onPtyData('pty-1', 'PR https://github.com/acme/orca/pull/4', 100)
    runtime.onPtyData('pty-1', '2\r\nand https://github.com/acme/orca/pull/43 done\r\n', 101)
    runtime.onPtyData('pty-1', 'again https://github.com/acme/orca/pull/42\r\n', 102)

    expect(batches).toHaveLength(1)
    expect(batches[0]).toMatchObject({
      ptyId: 'pty-1',
      worktreeId: TEST_WORKTREE_ID,
      tabId: 'tab-1'
    })
    expect(batches[0].facts).toEqual([
      {
        kind: 'pr-link',
        link: {
          url: 'https://github.com/acme/orca/pull/42',
          slug: { owner: 'acme', repo: 'orca', host: 'github.com' },
          number: 42
        }
      },
      {
        kind: 'pr-link',
        link: {
          url: 'https://github.com/acme/orca/pull/43',
          slug: { owner: 'acme', repo: 'orca', host: 'github.com' },
          number: 43
        }
      }
    ])
  })
})
