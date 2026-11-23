import { assert, describe, expect, it, vi } from 'vitest'
import { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty/provider-contract'
import type {
  RuntimeHeadlessTerminal,
  RuntimePtyWorktreeRecord
} from '../records/runtime-terminal-state-records'
import type { RuntimeTerminalRead } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import {
  clearNativeWindowsConptyPty,
  markNativeWindowsConptyPty
} from './terminal-model-query-authority'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from '../wait/agent-transcript-pane-test-harness'
import {
  anchorStream,
  createRuntime,
  grid,
  headlessOf,
  replay,
  stamped
} from './headless-recovery-test-harness'

const partial = 'prompt\r\n> \x1b[?'

it('restores a screen and live suffix without repainting a consumed escape continuation', async () => {
  const runtime = createRuntime()
  const continuation = '1002h\x1b[>4;2m'
  try {
    runtime.onPtyData('pty-snapshot', partial, 1)
    const pending = runtime.serializeHiddenOutputRecoveryBuffer('pty-snapshot')
    queueMicrotask(() => runtime.onPtyData('pty-snapshot', continuation, 2))
    const snapshot = await pending
    expect(await replay(snapshot, (partial + continuation).slice(snapshot?.seq))).toEqual([
      'prompt',
      '>'
    ])
  } finally {
    await runtime.onPtyExit('pty-snapshot', 0)
  }
})

it.each([false, true])(
  'preserves seeded parser state through replay and live output (reset=%s)',
  async (reset) => {
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => grid,
      hasRendererSerializer: () => true,
      serializeBuffer: async () => ({ data: 'prompt\r\n> ', ...grid, seq: 13 })
    })
    try {
      runtime.onPtyData('pty-seed', partial, 1)
      let snapshot = await runtime.serializeHiddenOutputRecoveryBuffer('pty-seed')
      expect(snapshot?.seq).toBe(13)
      if (reset) {
        await runtime.resetHeadlessTerminalInputModes('pty-seed')
        snapshot = await runtime.serializeHiddenOutputRecoveryBuffer('pty-seed')
      }
      const continuation = reset ? 'hello' : '1002h'
      const expected = reset ? ['prompt', '> hello'] : ['prompt', '>']
      expect(await replay(snapshot, continuation)).toEqual(expected)

      runtime.onPtyData('pty-seed', continuation, 2)
      const live = await runtime.serializeHiddenOutputRecoveryBuffer('pty-seed')
      expect(await replay(live, '')).toEqual(expected)
    } finally {
      await runtime.onPtyExit('pty-seed', 0)
    }
  }
)

it('rebuilds the screen from a provider snapshot plus the output after it, cutting a straddling chunk', async () => {
  // Recovery's capture and any reader's are separate requests; the daemon answers both alike.
  const pending: ((value: PtyProviderBufferSnapshot) => void)[] = []
  const capture: { land?: (value: PtyProviderBufferSnapshot) => void } = {}
  const runtime = createRuntime()
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => grid,
    serializeProviderBuffer: () =>
      new Promise<PtyProviderBufferSnapshot>((resolve) => {
        pending.push(resolve)
        capture.land = (value) => pending.forEach((land) => land(value))
      })
  })
  try {
    anchorStream(runtime, 'pty-gap')
    runtime.onPtyData('pty-gap', 'stale\r\n', 1)
    runtime.notePtyDataGap('pty-gap', 9)
    await vi.waitFor(() => assert(capture.land))
    // Seq 16 -> 20, after the capture was asked for: the daemon caught "ta" of it.
    runtime.onPtyData('pty-gap', 'tail', 2)
    assert(capture.land)
    expect(await runtime.serializeHiddenOutputRecoveryBuffer('pty-gap')).toBeNull()
    capture.land({ data: '\x1b[H\x1b[2Jfresh\r\nta', ...grid, seq: 18, source: 'headless' })
    // Main's own model, not a provider read that could share the landed capture.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: OrcaRuntimeService inherits this protected method with exactly this signature.
    const headless = runtime as unknown as {
      serializeHeadlessTerminalBuffer(ptyId: string): Promise<{ data: string } | null>
    }
    const snapshot = await vi.waitFor(async () => {
      const rebuilt = await headless.serializeHeadlessTerminalBuffer('pty-gap')
      assert(rebuilt)
      return rebuilt
    })
    expect(await replay(snapshot, '')).toEqual(['fresh', 'tail'])
  } finally {
    await runtime.onPtyExit('pty-gap', 0)
  }
})

it('recaptures when output arrived during a capture whose seq cannot place it', async () => {
  const snapshots: PtyProviderBufferSnapshot[] = [
    { data: 'before-gap', ...grid, seq: 7, source: 'headless' },
    { data: '\x1b[H\x1b[2Jfresh\r\ntail', ...grid, seq: 20, source: 'headless' }
  ]
  let captures = 0
  const runtime = createRuntime()
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => grid,
    serializeProviderBuffer: async () => {
      if (captures === 0) {
        // Output during the capture: with seq 7 the journal cannot tell what the snapshot holds.
        runtime.onPtyData('pty-stale', 'tail', 2)
      }
      return snapshots[Math.min(captures++, 1)]
    }
  })
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  try {
    anchorStream(runtime, 'pty-stale')
    runtime.onPtyData('pty-stale', 'stale\r\n', 1)
    runtime.notePtyDataGap('pty-stale', 9)
    // Captures are paced a second apart.
    await vi.advanceTimersByTimeAsync(5_000)
    vi.useRealTimers()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: OrcaRuntimeService inherits this protected method with exactly this signature.
    const headless = runtime as unknown as {
      serializeHeadlessTerminalBuffer(ptyId: string): Promise<{ data: string } | null>
    }
    const snapshot = await headless.serializeHeadlessTerminalBuffer('pty-stale')
    expect(captures).toBe(2)
    expect(await replay(snapshot, '')).toEqual(['fresh', 'tail'])
  } finally {
    vi.useRealTimers()
    await runtime.onPtyExit('pty-stale', 0)
  }
})

it('places a snapshot by the stream stamps when a reattach left this count ahead of the provider', async () => {
  const capture: { land?: (value: PtyProviderBufferSnapshot) => void } = {}
  const runtime = createRuntime()
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => grid,
    serializeProviderBuffer: () =>
      new Promise<PtyProviderBufferSnapshot>((resolve) => {
        capture.land = resolve
      })
  })
  try {
    // Delivered during the attach call and already inside the provider's baseline of 1000: counted twice.
    runtime.onPtyData('pty-drift', 'stale\r\n', 1)
    runtime.synchronizePtyOutputSequenceFromProvider('pty-drift', {
      value: 1000,
      generation: 'continued'
    })
    stamped(runtime, 'pty-drift', 'x'.repeat(10), 1010)
    runtime.notePtyDataGap('pty-drift', 9)
    const land = await vi.waitFor(() => {
      assert(capture.land)
      return capture.land
    })
    stamped(runtime, 'pty-drift', 'tail', 1023)
    land({ data: '\x1b[H\x1b[2Jfresh\r\ntail', ...grid, seq: 1023, source: 'headless' })
    const snapshot = await vi.waitFor(async () => {
      const rebuilt = await headlessOf(runtime).serializeHeadlessTerminalBuffer('pty-drift')
      assert(rebuilt)
      return rebuilt
    })
    expect(await replay(snapshot, '')).toEqual(['fresh', 'tail'])
  } finally {
    await runtime.onPtyExit('pty-drift', 0)
  }
})

it('restarts the screen at a gap until the stream is stamped, then rebuilds from the provider', async () => {
  const runtime = createRuntime()
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => grid,
    serializeProviderBuffer: async () => ({
      data: '\x1b[H\x1b[2Jprovider\r\nok',
      ...grid,
      seq: 22,
      source: 'headless' as const
    })
  })
  try {
    runtime.onPtyData('pty-unstamped', 'live\r\n', 1)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-unstamped',
      { value: 6, generation: 'continued' },
      6
    )
    runtime.notePtyDataGap('pty-unstamped', 9)
    runtime.onPtyData('pty-unstamped', 'after', 2)
    // As a fresh model would: the screen restarts from the output after the gap.
    const live = await vi.waitFor(async () => {
      const screen = await headlessOf(runtime).serializeHeadlessTerminalBuffer('pty-unstamped')
      assert(screen)
      return screen
    })
    expect(await replay(live, '')).toEqual(['after'])

    stamped(runtime, 'pty-unstamped', 'ok', 22)
    await vi.waitFor(async () => {
      const screen = await headlessOf(runtime).serializeHeadlessTerminalBuffer('pty-unstamped')
      expect(await replay(screen, '')).toEqual(['provider', 'ok'])
    })
  } finally {
    await runtime.onPtyExit('pty-unstamped', 0)
  }
})

it('cancels a recovery capture the provider never answers before freeing its slot', async () => {
  const signals: AbortSignal[] = []
  const runtime = createRuntime()
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => grid,
    serializeProviderBuffer: (_ptyId, opts) =>
      new Promise<PtyProviderBufferSnapshot | null>((resolve) => {
        assert(opts?.signal)
        signals.push(opts.signal)
        opts.signal.addEventListener('abort', () => resolve(null))
      })
  })
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  try {
    anchorStream(runtime, 'pty-hung')
    runtime.onPtyData('pty-hung', 'live\r\n', 1)
    runtime.notePtyDataGap('pty-hung', 9)
    await vi.advanceTimersByTimeAsync(36_000)
    expect(signals[0]?.aborted).toBe(true)
  } finally {
    vi.useRealTimers()
    await runtime.onPtyExit('pty-hung', 0)
  }
})

const historyGrid = { cols: 80, rows: 5 }

function historyReads(runtime: OrcaRuntimeService, ptyId: string) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inherited protected runtime methods retain these signatures.
  const reads = runtime as unknown as {
    recordPtyWorktree(ptyId: string, worktreeId: string): RuntimePtyWorktreeRecord
    readPtyTerminal(
      handle: string,
      pty: RuntimePtyWorktreeRecord,
      opts: { limit: number }
    ): RuntimeTerminalRead
    withVisibleSnapshotFallback(
      ptyId: string,
      read: RuntimeTerminalRead,
      opts: { limit: number }
    ): Promise<RuntimeTerminalRead>
    headlessTerminals: Map<string, RuntimeHeadlessTerminal>
  }
  const pty = reads.recordPtyWorktree(ptyId, '/test')
  const stream = () => reads.readPtyTerminal('term', pty, { limit: 2000 })
  const read = () => reads.withVisibleSnapshotFallback(ptyId, stream(), { limit: 2000 })
  return { stream, read, models: reads.headlessTerminals }
}

function recoveryHistory() {
  vi.stubEnv('ORCA_DAEMON_SESSION_SCROLLBACK_ROWS', '100')
  const runtime = createRuntime(100)
  const ptyId = 'pty-history'
  const reads = historyReads(runtime, ptyId)
  let rebuilt = false
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => historyGrid,
    serializeProviderBuffer: async (_ptyId, opts) => ({
      data: rebuilt ? 'WRONG' : 's1\r\ns2\r\ns3\r\ns4\r\ns5',
      scrollbackAnsi:
        !rebuilt && opts?.scrollbackRows
          ? `${Array.from({ length: 100 }, (_, index) => `h${index + 1}`).join('\r\n')}\r\n`
          : '',
      scrollbackLines: 100,
      ...historyGrid,
      seq: runtime.getPtyOutputSequence(ptyId),
      source: 'headless'
    })
  })
  markNativeWindowsConptyPty(ptyId)
  const ready = async () => {
    anchorStream(runtime, ptyId)
    runtime.onPtyData(ptyId, 'stale\r\n', 1)
    runtime.notePtyDataGap(ptyId, 9)
    await vi.waitFor(async () =>
      assert(await headlessOf(runtime).serializeHeadlessTerminalBuffer(ptyId))
    )
    rebuilt = true
    runtime.onPtyData(ptyId, '\r\np1\r\np2\r\np3', 2)
  }
  const close = async () => {
    clearNativeWindowsConptyPty(ptyId)
    vi.unstubAllEnvs()
    await runtime.onPtyExit(ptyId, 0)
  }
  return { ...reads, ready, close }
}

it('seeds recovered ConPTY history with the live window and later output', async () => {
  const { ready, read, close } = recoveryHistory()
  try {
    await ready()
    const result = await read()
    expect(result.tail).toEqual([
      'h4',
      'h5',
      'h6',
      'h7',
      'h8',
      'h9',
      'h10',
      'h11',
      'h12',
      'h13',
      'h14',
      'h15',
      'h16',
      'h17',
      'h18',
      'h19',
      'h20',
      'h21',
      'h22',
      'h23',
      'h24',
      'h25',
      'h26',
      'h27',
      'h28',
      'h29',
      'h30',
      'h31',
      'h32',
      'h33',
      'h34',
      'h35',
      'h36',
      'h37',
      'h38',
      'h39',
      'h40',
      'h41',
      'h42',
      'h43',
      'h44',
      'h45',
      'h46',
      'h47',
      'h48',
      'h49',
      'h50',
      'h51',
      'h52',
      'h53',
      'h54',
      'h55',
      'h56',
      'h57',
      'h58',
      'h59',
      'h60',
      'h61',
      'h62',
      'h63',
      'h64',
      'h65',
      'h66',
      'h67',
      'h68',
      'h69',
      'h70',
      'h71',
      'h72',
      'h73',
      'h74',
      'h75',
      'h76',
      'h77',
      'h78',
      'h79',
      'h80',
      'h81',
      'h82',
      'h83',
      'h84',
      'h85',
      'h86',
      'h87',
      'h88',
      'h89',
      'h90',
      'h91',
      'h92',
      'h93',
      'h94',
      'h95',
      'h96',
      'h97',
      'h98',
      'h99',
      'h100',
      's1',
      's2',
      's3',
      's4',
      's5',
      'p1',
      'p2',
      'p3'
    ])
    expect(result.limited).toBe(true)
    expect(result.source).toBe('screen')
  } finally {
    await close()
  }
})

it('marks recovered ConPTY history limited even when the stream was not limited', async () => {
  const { ready, read, stream, close } = recoveryHistory()
  try {
    await ready()
    expect(stream().limited).toBe(false)
    expect((await read()).limited).toBe(true)
  } finally {
    await close()
  }
})

it('labels an actual blank ConPTY grid as screen evidence', async () => {
  const runtime = createRuntime()
  const ptyId = 'pty-blank'
  const { read } = historyReads(runtime, ptyId)
  markNativeWindowsConptyPty(ptyId)
  try {
    runtime.synchronizePtyOutputSequenceFromProvider(ptyId, { value: 0, generation: 'reset' })
    runtime.anchorProviderSequence(ptyId, 0, 0)
    runtime.onPtyData(ptyId, '\x1b[2J\x1b[H', 1)
    await vi.waitFor(async () => {
      const result = await read()
      expect(result.tail).toEqual([])
      expect(result.source).toBe('screen')
    })
  } finally {
    clearNativeWindowsConptyPty(ptyId)
    await runtime.onPtyExit(ptyId, 0)
  }
})

it('returns empty limited ConPTY history instead of the gapped stream during recovery', async () => {
  const runtime = createRuntime(100)
  const ptyId = 'pty-unavailable'
  const { read, stream } = historyReads(runtime, ptyId)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => historyGrid,
    serializeProviderBuffer: async (_ptyId, opts) =>
      opts?.recovery
        ? new Promise<null>((resolve) =>
            opts.signal?.addEventListener('abort', () => resolve(null), { once: true })
          )
        : null
  })
  markNativeWindowsConptyPty(ptyId)
  try {
    anchorStream(runtime, ptyId)
    runtime.onPtyData(ptyId, 'stale-1\r\nstale-2\r\nstale-3\r\nstale-4\r\nstale-5\r\n', 1)
    runtime.notePtyDataGap(ptyId, 9)
    expect(stream().tail).toEqual(['stale-1', 'stale-2', 'stale-3', 'stale-4', 'stale-5'])
    const result = await read()
    expect(result.tail).toEqual([])
    expect(result.limited).toBe(true)
    expect(result.source).toBe('screen-unavailable')
  } finally {
    clearNativeWindowsConptyPty(ptyId)
    await runtime.onPtyExit(ptyId, 0)
  }
})

it('returns empty limited ConPTY history when recovery finishes during the provider read', async () => {
  const runtime = createRuntime(100)
  const ptyId = 'pty-read-spans-recovery'
  const { read } = historyReads(runtime, ptyId)
  let recover: ((snapshot: PtyProviderBufferSnapshot) => void) | undefined
  let finishRead: ((snapshot: null) => void) | undefined
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => historyGrid,
    serializeProviderBuffer: (_ptyId, opts) =>
      new Promise<PtyProviderBufferSnapshot | null>((resolve) => {
        if (opts?.recovery) {
          recover = resolve
        } else {
          finishRead = resolve
        }
      })
  })
  markNativeWindowsConptyPty(ptyId)
  try {
    // A freshly spawned stream: main's model owned this screen before the gap.
    runtime.synchronizePtyOutputSequenceFromProvider(ptyId, { value: 0, generation: 'reset' })
    runtime.anchorProviderSequence(ptyId, 0, 0)
    runtime.onPtyData(ptyId, 'stale-1\r\nstale-2\r\n', 1)
    runtime.notePtyDataGap(ptyId, 9)
    await vi.waitFor(() => assert(recover))
    const pendingRead = read()
    await vi.waitFor(() => assert(finishRead))
    assert(recover)
    recover({ data: 'ready', ...historyGrid, seq: 27, source: 'headless' })
    await vi.waitFor(() => assert(headlessOf(runtime).readWholeScreenModel(ptyId)))
    assert(finishRead)
    finishRead(null)
    const result = await pendingRead
    expect(result.tail).toEqual([])
    expect(result.limited).toBe(true)
    expect(result.source).toBe('screen-unavailable')
  } finally {
    clearNativeWindowsConptyPty(ptyId)
    await runtime.onPtyExit(ptyId, 0)
  }
})

it('keeps recovering without old history when a pre-clear recovery capture lands', async () => {
  const runtime = createRuntime(100)
  const ptyId = 'pty-clear'
  const { models } = historyReads(runtime, ptyId)
  let release: ((snapshot: PtyProviderBufferSnapshot) => void) | undefined
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => historyGrid,
    serializeProviderBuffer: () =>
      new Promise<PtyProviderBufferSnapshot>((resolve) => {
        release = resolve
      })
  })
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  try {
    anchorStream(runtime, ptyId)
    runtime.onPtyData(ptyId, 'screen\r\n', 1)
    runtime.notePtyDataGap(ptyId, 9)
    await vi.advanceTimersByTimeAsync(10)
    assert(release)
    const snapshot: PtyProviderBufferSnapshot = {
      data: 'current screen',
      scrollbackAnsi: 'OLD-HISTORY\r\n',
      scrollbackLines: 100,
      ...historyGrid,
      seq: runtime.getPtyOutputSequence(ptyId),
      source: 'headless'
    }
    await runtime.clearHeadlessTerminalBuffer(ptyId)
    release(snapshot)
    await vi.advanceTimersByTimeAsync(100)
    expect(await headlessOf(runtime).serializeHeadlessTerminalBuffer(ptyId)).toBeNull()
    expect(models.get(ptyId)?.emulator.getBufferTailLines(2000).join('\n')).not.toContain(
      'OLD-HISTORY'
    )
  } finally {
    vi.useRealTimers()
    await runtime.onPtyExit(ptyId, 0)
  }
})

it('clamps recovery seed capture to 1000 scrollback rows with a configured 5000-row window', async () => {
  vi.stubEnv('ORCA_DAEMON_SESSION_SCROLLBACK_ROWS', '5000')
  const runtime = createRuntime(100)
  const ptyId = 'pty-clamp'
  let scrollbackRows: number | undefined
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => historyGrid,
    serializeProviderBuffer: async (_ptyId, opts) => {
      scrollbackRows = opts?.scrollbackRows
      return {
        data: 'current',
        ...historyGrid,
        seq: runtime.getPtyOutputSequence(ptyId),
        source: 'headless'
      }
    }
  })
  try {
    anchorStream(runtime, ptyId)
    runtime.onPtyData(ptyId, 'stale\r\n', 1)
    runtime.notePtyDataGap(ptyId, 9)
    await vi.waitFor(async () =>
      assert(await headlessOf(runtime).serializeHeadlessTerminalBuffer(ptyId))
    )
    expect(scrollbackRows).toBe(1000)
  } finally {
    vi.unstubAllEnvs()
    await runtime.onPtyExit(ptyId, 0)
  }
})

it('never publishes Freebuff done from a half-drawn synchronized recovery frame', async () => {
  const published: string[] = []
  let frameOpen = true
  const { runtime } = await createTranscriptPane(
    { paneTitle: 'Freebuff', foregroundProcess: 'freebuff', launchAgent: 'freebuff', data: '' },
    { onTerminalAgentStatus: ({ payload }) => published.push(payload.state) }
  )
  const ptyId = TRANSCRIPT_PANE_PTY_ID
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => 'freebuff',
    getSize: () => grid,
    serializeProviderBuffer: async () => ({
      data: frameOpen
        ? '\x1b[?1049h\x1b[H\x1b[2J1m left End session\r\n╭──╮\r\n│  │\r\n╰──╯\r\n/model to change Chat: example'
        : '\x1b[?1049h\x1b[H\x1b[2Jworking...\r\n╭──╮\r\n│  │\r\n╰──╯\r\n/model to change Chat: example',
      ...grid,
      seq: runtime.getPtyOutputSequence(ptyId),
      source: 'headless',
      synchronizedOutput: frameOpen
    })
  })
  try {
    anchorStream(runtime, ptyId)
    runtime.onPtyData(
      ptyId,
      '\x1b]0;Freebuff: first\x07\x1b[?1049hworking...\r\n╭──╮\r\n│  │\r\n╰──╯\r\n/model to change Chat: example',
      1
    )
    await vi.waitFor(() => expect(published).toEqual(['working']))
    runtime.notePtyDataGap(ptyId, 9)
    expect(published).toEqual(['working'])
    frameOpen = false
    runtime.onPtyData(ptyId, '\x1b]0;Freebuff: second\x07\x1b[H\x1b[2Kworking...\x1b[?2026l', 2)
    await vi.waitFor(() => expect(published).toEqual(['working', 'working']), { timeout: 5000 })
  } finally {
    await runtime.onPtyExit(ptyId, 0)
  }
})

describe('the hidden renderer after dropped output', () => {
  function createRendererRuntime() {
    const pending: ((value: { data: string; cols: number; rows: number }) => void)[] = []
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => grid,
      hasRendererSerializer: () => true,
      serializeBuffer: () => new Promise((resolve) => pending.push(resolve)),
      serializeProviderBuffer: async () => ({
        data: '\x1b[H\x1b[2JNEW',
        ...grid,
        seq: runtime.getPtyOutputSequence('pty-r'),
        source: 'headless' as const
      })
    })
    // Recovery and its renderer fence apply to a stamped stream; an unstamped one behaves as before.
    anchorStream(runtime, 'pty-r')
    const replyOld = () => pending.shift()?.({ data: 'OLD', ...grid })
    return { runtime, replyOld }
  }

  it.each(['gap', 'recovered', 'exit'] as const)(
    'drops a renderer read that spans a gap (%s)',
    async (after) => {
      const { runtime, replyOld } = createRendererRuntime()
      const read = runtime.serializeRendererTerminalBuffer('pty-r')
      runtime.notePtyDataGap('pty-r', 5)
      if (after === 'recovered') {
        await vi.waitFor(async () => {
          expect(await runtime.serializeHiddenOutputRecoveryBuffer('pty-r')).not.toBeNull()
        })
      } else if (after === 'exit') {
        await runtime.onPtyExit('pty-r', 0)
      }
      replyOld()
      expect(await read).toBeNull()
      await runtime.onPtyExit('pty-r', 0)
    }
  )

  it('never reads the renderer again once its PTY has gapped, but does without a gap', async () => {
    const { runtime, replyOld } = createRendererRuntime()
    const control = runtime.serializeRendererTerminalBuffer('pty-r')
    replyOld()
    expect((await control)?.data).toBe('OLD')
    runtime.notePtyDataGap('pty-r', 5)
    await vi.waitFor(async () => {
      expect(await runtime.serializeHiddenOutputRecoveryBuffer('pty-r')).not.toBeNull()
    })
    const after = runtime.serializeRendererTerminalBuffer('pty-r')
    replyOld()
    expect(await after).toBeNull()
    await runtime.onPtyExit('pty-r', 0)
  })

  it('leaves a gap that lands during the renderer seed write to recovery', async () => {
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => grid,
      hasRendererSerializer: () => true,
      serializeBuffer: async () => ({ data: 'OLD', ...grid }),
      // Recovery's capture stays in flight: the screen is still being rebuilt when the seed finishes.
      serializeProviderBuffer: () => new Promise<PtyProviderBufferSnapshot>(() => {})
    })
    anchorStream(runtime, 'pty-r')
    const write = HeadlessEmulator.prototype.write
    const spy = vi.spyOn(HeadlessEmulator.prototype, 'write').mockImplementation(function (
      this: HeadlessEmulator,
      data: string
    ) {
      const written = write.call(this, data)
      if (data === 'OLD') {
        runtime.notePtyDataGap('pty-r', 5)
      }
      return written
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: OrcaRuntimeService inherits these protected members with exactly these types.
    const internals = runtime as unknown as {
      maybeHydrateHeadlessFromRenderer(ptyId: string): Promise<boolean> | null
      providerSnapshotPreferredPtys: Set<string>
    }
    try {
      expect(await internals.maybeHydrateHeadlessFromRenderer('pty-r')).toBe(false)
      expect(internals.providerSnapshotPreferredPtys.has('pty-r')).toBe(true)
      expect(headlessOf(runtime).readWholeScreenModel('pty-r')).toBeNull()
    } finally {
      spy.mockRestore()
      await runtime.onPtyExit('pty-r', 0)
    }
  })
})

it("keeps a late capture's alternate screen when the model that took the screen back was disposed by a gap", async () => {
  const runtime = createRuntime()
  const ptyId = 'pty-late-mode'
  let release: (() => void) | undefined
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => grid,
    serializeProviderBuffer: () =>
      new Promise<PtyProviderBufferSnapshot>((resolve) => {
        release = () =>
          resolve({
            data: '\x1b[?1049h\x1b[Htui',
            ...grid,
            seq: 0,
            source: 'headless',
            alternateScreen: true
          })
      })
  })
  try {
    runtime.synchronizePtyOutputSequenceFromProvider(ptyId, { value: 0, generation: 'continued' })
    const read = runtime.serializeTerminalBuffer(ptyId, { scrollbackRows: 0 })
    await vi.waitFor(() => assert(release))
    runtime.seedHeadlessTerminal(ptyId, '\x1b[?1049h\x1b[Htui', grid)
    await vi.waitFor(() => expect(runtime.isTerminalAlternateScreen(ptyId)).toBe(true))
    runtime.notePtyDataGap(ptyId, 9)
    release?.()
    await read
    expect(runtime.isTerminalAlternateScreen(ptyId)).toBe(true)
  } finally {
    await runtime.onPtyExit(ptyId, 0)
  }
})
