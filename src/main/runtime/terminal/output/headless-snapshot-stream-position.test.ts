import { assert, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty/provider-contract'
import type { RuntimeTerminalRead } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import {
  clearNativeWindowsConptyPty,
  markNativeWindowsConptyPty
} from './terminal-model-query-authority'

const grid = { cols: 80, rows: 24 }
const partial = 'prompt\r\n> \x1b[?'

function createRuntime() {
  const runtime = new OrcaRuntimeService()
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => grid
  })
  return runtime
}

// A daemon stream that has stamped its position since attach, at zero offset.
function anchorStream(runtime: OrcaRuntimeService, ptyId: string): void {
  runtime.synchronizePtyOutputSequenceFromProvider(ptyId, { value: 0, generation: 'continued' })
  runtime.anchorProviderSequence(ptyId, 0, 0)
}

async function replay(
  snapshot: { data: string; pendingEscapeTailAnsi?: string } | null,
  suffix: string
) {
  assert(snapshot)
  const restored = new HeadlessEmulator(grid)
  try {
    await restored.write(snapshot.data)
    await restored.write(snapshot.pendingEscapeTailAnsi ?? '')
    await restored.write(suffix)
    return restored
      .getVisibleLines()
      .map((line) => line.trimEnd())
      .filter(Boolean)
  } finally {
    restored.dispose()
  }
}

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

const headlessOf = (runtime: OrcaRuntimeService) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: OrcaRuntimeService inherits this protected method with exactly this signature.
  runtime as unknown as {
    serializeHeadlessTerminalBuffer(ptyId: string): Promise<{ data: string } | null>
  }

// As the provider listener delivers a frame the daemon stamped with its stream position.
const stamped = (runtime: OrcaRuntimeService, ptyId: string, data: string, seq: number) =>
  runtime.anchorProviderSequence(ptyId, runtime.onPtyData(ptyId, data, 2), seq)

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

it("reads a rebuilt ConPTY terminal's history from the provider, which kept it", async () => {
  const lines = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`)
  const runtime = createRuntime()
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => grid,
    serializeProviderBuffer: async (_ptyId, opts) => ({
      data: opts?.scrollbackRows ? lines.join('\r\n') : '\x1b[H\x1b[2Jline 200',
      ...grid,
      seq: 16,
      source: 'headless'
    })
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: OrcaRuntimeService inherits these protected methods with exactly these signatures.
  const reads = runtime as unknown as {
    serializeHeadlessTerminalBuffer(ptyId: string): Promise<{ data: string } | null>
    withVisibleSnapshotFallback(
      ptyId: string,
      read: RuntimeTerminalRead,
      opts: { limit?: number }
    ): Promise<RuntimeTerminalRead>
  }
  markNativeWindowsConptyPty('pty-win')
  try {
    anchorStream(runtime, 'pty-win')
    runtime.onPtyData('pty-win', 'stale\r\n', 1)
    runtime.notePtyDataGap('pty-win', 9)
    await vi.waitFor(async () => assert(await reads.serializeHeadlessTerminalBuffer('pty-win')))
    const read = await reads.withVisibleSnapshotFallback(
      'pty-win',
      { handle: 'term', status: 'running', tail: ['line 200'], truncated: false, nextCursor: null },
      { limit: 120 }
    )
    expect(read.tail).toEqual(lines.slice(-120))
  } finally {
    clearNativeWindowsConptyPty('pty-win')
    await runtime.onPtyExit('pty-win', 0)
  }
})

it.each([
  {
    limit: 1500,
    available: 6000,
    coverage: 'complete',
    busy: false,
    count: 1500,
    first: 'line 4501',
    limited: false
  },
  {
    limit: 2000,
    available: 6000,
    coverage: 'complete',
    busy: false,
    count: 2000,
    first: 'line 4001',
    limited: false
  },
  {
    limit: 5000,
    available: 6000,
    coverage: 'complete',
    busy: false,
    count: 2000,
    first: 'line 4001',
    limited: false
  },
  {
    limit: 2000,
    available: 1112,
    coverage: 'complete',
    busy: false,
    count: 1112,
    first: 'line 1',
    limited: true
  },
  {
    limit: 2000,
    available: 1111,
    coverage: 'complete',
    busy: true,
    count: 1111,
    first: 'line 1',
    limited: true
  },
  {
    limit: 2000,
    available: 1112,
    coverage: 'limited',
    busy: false,
    count: 1112,
    first: 'line 1',
    limited: true
  },
  {
    limit: 2000,
    available: 6000,
    coverage: 'limited',
    busy: false,
    count: 2000,
    first: 'line 4001',
    limited: false
  },
  {
    limit: 2000,
    available: 1112,
    coverage: 'unavailable',
    busy: false,
    count: 1000,
    first: 'line 113',
    limited: true
  }
])(
  'reads recovered history with its own coverage ($limit, $coverage, busy=$busy, available=$available)',
  async ({ limit, available, coverage, busy, count, first, limited }) => {
    const lines = Array.from({ length: available }, (_, index) => `line ${index + 1}`)
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => grid,
      serializeProviderBuffer: async (_ptyId, opts) => {
        if ((opts?.scrollbackRows ?? 0) > 1000 && coverage === 'unavailable') {
          return null
        }
        if (busy && opts?.scrollbackRows) {
          stamped(runtime, 'pty-big', 'busy output\r\n', 1_000_000)
        }
        return {
          data: opts?.scrollbackRows ? lines.join('\r\n') : '\x1b[H\x1b[2Jrecovered screen',
          ...grid,
          seq: opts?.scrollbackRows ? 1_000_000 : 16,
          source: 'headless',
          ...(coverage === 'limited' ? { historyLimited: true as const } : {})
        }
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: OrcaRuntimeService inherits these protected methods with exactly these signatures.
    const reads = runtime as unknown as {
      serializeHeadlessTerminalBuffer(ptyId: string): Promise<{ data: string } | null>
      withVisibleSnapshotFallback(
        ptyId: string,
        read: RuntimeTerminalRead,
        opts: { limit?: number }
      ): Promise<RuntimeTerminalRead>
    }
    markNativeWindowsConptyPty('pty-big')
    try {
      anchorStream(runtime, 'pty-big')
      runtime.onPtyData('pty-big', 'stale\r\n', 1)
      runtime.notePtyDataGap('pty-big', 9)
      await vi.waitFor(async () => assert(await reads.serializeHeadlessTerminalBuffer('pty-big')))
      runtime.onPtyData('pty-big', 'stale burst\r\n'.repeat(60), 2)
      const read = await reads.withVisibleSnapshotFallback(
        'pty-big',
        {
          handle: 'term',
          status: 'running',
          tail: ['stale burst'],
          truncated: true,
          limited: !busy,
          nextCursor: null
        },
        { limit }
      )
      expect(read.tail.at(-1)).toBe(`line ${available}`)
      expect(read.tail[0]).toBe(first)
      expect(read.tail).toHaveLength(count)
      expect(read.tail).not.toContain('stale burst')
      expect(read.limited).toBe(limited)
    } finally {
      clearNativeWindowsConptyPty('pty-big')
      await runtime.onPtyExit('pty-big', 0)
    }
  }
)

it('keeps a synchronized-output frame open across a rebuild until the frame ends', async () => {
  const runtime = createRuntime()
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => grid,
    serializeProviderBuffer: async () => ({
      data: '\x1b[H\x1b[2Jhalf a frame',
      ...grid,
      seq: 16,
      source: 'headless',
      synchronizedOutput: true
    })
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: OrcaRuntimeService inherits this protected method with exactly this signature.
  const models = runtime as unknown as {
    readWholeScreenModel(ptyId: string): { emulator: { isSynchronizedOutput: boolean } } | null
  }
  try {
    anchorStream(runtime, 'pty-sync')
    runtime.onPtyData('pty-sync', 'stale\r\n', 1)
    runtime.notePtyDataGap('pty-sync', 9)
    const model = await vi.waitFor(() => {
      const rebuilt = models.readWholeScreenModel('pty-sync')
      assert(rebuilt)
      return rebuilt
    })
    expect(model.emulator.isSynchronizedOutput).toBe(true)
    runtime.onPtyData('pty-sync', ' drawn\x1b[?2026l', 2)
    await vi.waitFor(() => expect(model.emulator.isSynchronizedOutput).toBe(false))
  } finally {
    await runtime.onPtyExit('pty-sync', 0)
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
})
