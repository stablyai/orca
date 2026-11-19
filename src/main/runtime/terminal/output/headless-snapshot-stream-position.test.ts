import { assert, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty/provider-contract'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import { serializeBudgetedRequestedSnapshot } from '../../rpc/methods/terminal/terminal-snapshot-publication'
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

function historyReads(runtime: OrcaRuntimeService, ptyId: string) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inherited protected runtime methods retain these signatures.
  const reads = runtime as unknown as {
    recordPtyWorktree(ptyId: string, worktreeId: string): RuntimePtyWorktreeRecord
    readPtyTerminal(
      handle: string,
      pty: RuntimePtyWorktreeRecord,
      opts: { cursor?: number; limit: number }
    ): RuntimeTerminalRead
    withVisibleSnapshotFallback(
      ptyId: string,
      read: RuntimeTerminalRead,
      opts: { cursor?: number; limit: number }
    ): Promise<RuntimeTerminalRead>
  }
  const pty = reads.recordPtyWorktree(ptyId, '/test')
  const stream = (opts = { limit: 2000 }) => reads.readPtyTerminal('term', pty, opts)
  const read = (opts: { cursor?: number; limit: number } = { limit: 2000 }) =>
    reads.withVisibleSnapshotFallback(ptyId, stream(opts), opts)
  return { stream, read }
}

function recoveredHistoryRuntime(historyRows: number, oldOutput = 'stale\r\n') {
  const runtime = createRuntime()
  const { read, stream } = historyReads(runtime, 'pty-history')
  const history = Array.from({ length: historyRows }, (_, index) => `h${index + 1}`)
  const screen = Array.from({ length: 24 }, (_, index) => `s${index + 1}`)
  let rebuilt = false
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => grid,
    serializeProviderBuffer: async (_ptyId, opts) => ({
      data: rebuilt ? 'different provider rows' : screen.join('\r\n'),
      scrollbackAnsi:
        !rebuilt && opts?.scrollbackRows
          ? `${history.slice(-opts.scrollbackRows).join('\r\n')}\r\n`
          : '',
      scrollbackLines: Math.min(historyRows, opts?.scrollbackRows ?? historyRows),
      ...grid,
      seq: runtime.getPtyOutputSequence('pty-history'),
      source: 'headless'
    })
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inherited protected runtime methods retain these signatures.
  const reads = runtime as unknown as {
    serializeHeadlessTerminalBuffer(ptyId: string): Promise<{ data: string } | null>
    withVisibleSnapshotFallback(
      ptyId: string,
      read: RuntimeTerminalRead,
      opts: { limit: number }
    ): Promise<RuntimeTerminalRead>
  }
  const ready = async () => {
    anchorStream(runtime, 'pty-history')
    runtime.onPtyData('pty-history', oldOutput, 1)
    runtime.notePtyDataGap('pty-history', 9)
    await vi.waitFor(async () => assert(await reads.serializeHeadlessTerminalBuffer('pty-history')))
    rebuilt = true
  }
  return { runtime, ready, read, stream }
}

it('reads the seeded live history and later output locally after a history cut', async () => {
  const { runtime, ready, read } = recoveredHistoryRuntime(1000)
  markNativeWindowsConptyPty('pty-history')
  try {
    await ready()
    runtime.onPtyData(
      'pty-history',
      `\r\n${Array.from({ length: 50 }, (_, index) => `p${index + 1}`).join('\r\n')}`,
      2
    )
    const result = await read()
    expect(result.tail).toEqual([
      ...Array.from({ length: 1000 }, (_, index) => `h${index + 1}`),
      ...Array.from({ length: 24 }, (_, index) => `s${index + 1}`),
      ...Array.from({ length: 50 }, (_, index) => `p${index + 1}`)
    ])
    expect(result.limited).toBe(true)
  } finally {
    clearNativeWindowsConptyPty('pty-history')
    await runtime.onPtyExit('pty-history', 0)
  }
})

it('does not mark short complete recovered history limited', async () => {
  const { runtime, ready, read, stream } = recoveredHistoryRuntime(
    200,
    `${Array.from({ length: 600 }, (_, index) => `old${index + 1}`).join('\r\n')}\r\n`
  )
  markNativeWindowsConptyPty('pty-history')
  try {
    await ready()
    expect(stream({ limit: 500 }).limited).toBe(true)
    const result = await read({ limit: 500 })
    expect(result.tail).toEqual([
      ...Array.from({ length: 200 }, (_, index) => `h${index + 1}`),
      ...Array.from({ length: 24 }, (_, index) => `s${index + 1}`)
    ])
    expect(result.limited).toBe(false)
  } finally {
    clearNativeWindowsConptyPty('pty-history')
    await runtime.onPtyExit('pty-history', 0)
  }
})

it('keeps cleared history out when an earlier recovery capture lands', async () => {
  const runtime = createRuntime()
  const { read } = historyReads(runtime, 'pty-clear')
  let release: ((snapshot: PtyProviderBufferSnapshot) => void) | undefined
  let cleared = false
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => grid,
    serializeProviderBuffer: async () => {
      if (!cleared) {
        return new Promise<PtyProviderBufferSnapshot>((resolve) => {
          release = resolve
        })
      }
      return {
        data: 'current screen',
        scrollbackLines: 0,
        ...grid,
        seq: runtime.getPtyOutputSequence('pty-clear'),
        source: 'headless'
      }
    }
  })
  try {
    anchorStream(runtime, 'pty-clear')
    runtime.onPtyData('pty-clear', 'OLD-HISTORY\r\n'.repeat(30), 1)
    runtime.notePtyDataGap('pty-clear', 9)
    const land = await vi.waitFor(() => {
      assert(release)
      return release
    })
    const oldSnapshot: PtyProviderBufferSnapshot = {
      data: 'current screen',
      scrollbackAnsi: 'OLD-HISTORY\r\n',
      scrollbackLines: 1000,
      ...grid,
      seq: runtime.getPtyOutputSequence('pty-clear'),
      source: 'headless'
    }
    cleared = true
    await runtime.clearHeadlessTerminalBuffer('pty-clear')
    land(oldSnapshot)
    await vi.waitFor(async () =>
      assert(await headlessOf(runtime).serializeHeadlessTerminalBuffer('pty-clear'))
    )
    expect((await read()).tail).toEqual(['current screen'])
    expect((await read()).limited).toBe(false)
    const ansi = await runtime.serializeAuthoritativeTerminalBuffer('pty-clear', {
      scrollbackRows: 5000
    })
    assert(ansi)
    expect(`${ansi.scrollbackAnsi ?? ''}${ansi.data}`).not.toContain('OLD-HISTORY')
  } finally {
    await runtime.onPtyExit('pty-clear', 0)
  }
})

it('resets cut coverage when recovered history is cleared', async () => {
  const { runtime, ready, read } = recoveredHistoryRuntime(1000)
  try {
    await ready()
    expect((await read()).limited).toBe(true)
    await runtime.clearHeadlessTerminalBuffer('pty-history')
    expect((await read()).limited).toBe(false)
  } finally {
    await runtime.onPtyExit('pty-history', 0)
  }
})

it('never returns spliced stream rows on a normal non-ConPTY screen', async () => {
  const runtime = createRuntime()
  const { read } = historyReads(runtime, 'pty-posix')
  let release: ((snapshot: PtyProviderBufferSnapshot) => void) | undefined
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => grid,
    serializeProviderBuffer: async (_ptyId, opts) => {
      if (opts?.recovery) {
        return new Promise<PtyProviderBufferSnapshot>((resolve) => {
          release = resolve
        })
      }
      return null
    }
  })
  try {
    anchorStream(runtime, 'pty-posix')
    runtime.onPtyData('pty-posix', 'before', 1)
    runtime.notePtyDataGap('pty-posix', 10)
    runtime.onPtyData('pty-posix', 'after\r\n', 2)
    const land = await vi.waitFor(() => {
      assert(release)
      return release
    })
    expect((await read()).tail).toEqual([])
    expect((await read()).limited).toBe(true)
    expect((await read({ cursor: 0, limit: 2000 })).tail).toEqual(['beforeafter'])
    land({
      data: 'before\r\nmiddle\r\nafter\r\n',
      scrollbackLines: 0,
      ...grid,
      seq: runtime.getPtyOutputSequence('pty-posix'),
      source: 'headless'
    })
    await vi.waitFor(async () =>
      assert(await headlessOf(runtime).serializeHeadlessTerminalBuffer('pty-posix'))
    )
    expect((await read()).tail).toEqual(['before', 'middle', 'after'])
  } finally {
    await runtime.onPtyExit('pty-posix', 0)
  }
})

it('publishes requested snapshots from retained recovered history plus later output', async () => {
  const { runtime, ready } = recoveredHistoryRuntime(1000)
  try {
    await ready()
    runtime.onPtyData(
      'pty-history',
      `\r\n${Array.from({ length: 2000 }, (_, index) => `p${index + 1}`).join('\r\n')}`,
      2
    )
    const initial = await runtime.serializeTerminalBuffer('pty-history', { scrollbackRows: 5000 })
    const requested = await serializeBudgetedRequestedSnapshot(runtime, 'pty-history', 5000)
    assert(initial)
    assert(requested)
    expect(requested.data).toBe(`${initial.scrollbackAnsi ?? ''}${initial.data}`)
    expect(requested.data).toContain('h1\r\n')
    expect(requested.data).toContain('p2000')
    expect(requested.data).not.toContain('different provider rows')
  } finally {
    await runtime.onPtyExit('pty-history', 0)
  }
})

it('reports the capped window on requested snapshots without marking complete 980-line reads limited', async () => {
  const runtime = createRuntime()
  const { read } = historyReads(runtime, 'pty-capped')
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => grid,
    serializeProviderBuffer: async (_ptyId, opts) => {
      if (opts?.recovery) {
        return new Promise<null>((resolve) => {
          opts.signal?.addEventListener('abort', () => resolve(null), { once: true })
        })
      }
      return {
        data: Array.from({ length: 1000 }, (_, index) => `line${index + 1}`).join('\r\n'),
        scrollbackLines: 976,
        ...grid,
        seq: runtime.getPtyOutputSequence('pty-capped'),
        source: 'headless'
      }
    }
  })
  try {
    anchorStream(runtime, 'pty-capped')
    runtime.onPtyData('pty-capped', 'stale\r\n', 1)
    runtime.notePtyDataGap('pty-capped', 9)
    const result = await read({ limit: 980 })
    expect(result.tail).toHaveLength(980)
    expect(result.tail[0]).toBe('line21')
    expect(result.tail.at(-1)).toBe('line1000')
    expect(result.limited).toBe(false)
    const snapshot = await serializeBudgetedRequestedSnapshot(runtime, 'pty-capped', 5000)
    expect(snapshot?.scrollbackRows).toBe(1000)
    expect(snapshot?.truncatedByByteBudget).toBe(true)
  } finally {
    await runtime.onPtyExit('pty-capped', 0)
  }
})

it.each([0, -10, 100_000_000])('bounds provider projections for user limit %s', async (limit) => {
  const runtime = createRuntime()
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => grid,
    serializeProviderBuffer: async () => ({
      data: Array.from({ length: 2500 }, (_, index) => `line${index + 1}`).join('\r\n'),
      ...grid,
      seq: 0,
      source: 'headless'
    })
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inherited protected runtime method retains this signature.
  const reads = runtime as unknown as {
    readProviderTerminalTailLines(ptyId: string, limit: number): Promise<{ lines: string[] }>
  }
  try {
    const result = await reads.readProviderTerminalTailLines('pty-limit', limit)
    expect(result.lines).toHaveLength(limit > 0 ? 2000 : 120)
    expect(result.lines[0]).toBe(limit > 0 ? 'line501' : 'line2381')
    expect(result.lines.at(-1)).toBe('line2500')
  } finally {
    await runtime.onPtyExit('pty-limit', 0)
  }
})

it.each([500, 5000])('uses the configured live window for recovery (%s rows)', async (window) => {
  vi.stubEnv('ORCA_DAEMON_SESSION_SCROLLBACK_ROWS', String(window))
  const { runtime, ready, read } = recoveredHistoryRuntime(window)
  try {
    await ready()
    const result = await read({ limit: 2000 })
    expect(result.limited).toBe(window === 500)
    expect(result.tail[0]).toBe(window === 500 ? 'h1' : 'h3025')
    expect(result.tail.at(-1)).toBe('s24')
  } finally {
    vi.unstubAllEnvs()
    await runtime.onPtyExit('pty-history', 0)
  }
})

it('caps mid-recovery acquisitions and never falls back to the stale stream', async () => {
  const runtime = createRuntime()
  const requests: (number | undefined)[] = []
  let recovering = false
  let replyOld: ((snapshot: PtyProviderBufferSnapshot) => void) | undefined
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => grid,
    serializeProviderBuffer: async (_ptyId, opts) => {
      if (opts?.recovery) {
        return new Promise<null>((resolve) => {
          opts.signal?.addEventListener('abort', () => resolve(null), { once: true })
        })
      }
      if (!recovering) {
        return new Promise<PtyProviderBufferSnapshot>((resolve) => {
          replyOld = resolve
        })
      }
      requests.push(opts?.scrollbackRows)
      return null
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inherited protected runtime methods retain these signatures.
  const reads = runtime as unknown as {
    serializeProviderTerminalBuffer(
      ptyId: string,
      opts: { scrollbackRows?: number }
    ): Promise<PtyProviderBufferSnapshot | null>
    serializeTerminalBufferFromAvailableState(
      ptyId: string,
      opts: { scrollbackRows?: number }
    ): Promise<PtyProviderBufferSnapshot | null>
    withVisibleSnapshotFallback(
      ptyId: string,
      read: RuntimeTerminalRead,
      opts: { limit: number }
    ): Promise<RuntimeTerminalRead>
  }
  markNativeWindowsConptyPty('pty-mid')
  try {
    anchorStream(runtime, 'pty-mid')
    runtime.onPtyData('pty-mid', 'stale-before\r\n', 1)
    const old = reads.serializeProviderTerminalBuffer('pty-mid', { scrollbackRows: 5000 })
    recovering = true
    runtime.notePtyDataGap('pty-mid', 9)
    const result = await reads.withVisibleSnapshotFallback(
      'pty-mid',
      {
        handle: 'term',
        status: 'running',
        tail: ['stale-before', 'stale-after'],
        truncated: false,
        nextCursor: null
      },
      { limit: 2000 }
    )
    expect(requests).toEqual([1000])
    expect(result.tail).toEqual([])
    expect(result.limited).toBe(true)
    expect(
      await runtime.serializeHiddenOutputRecoveryBuffer('pty-mid', { scrollbackRows: 5000 })
    ).toBeNull()
    expect(await reads.serializeTerminalBufferFromAvailableState('pty-mid', {})).toBeNull()
    expect(requests).toEqual([1000, 1000, 1000])
    replyOld?.({ data: 'stale-old-acquisition', ...grid, seq: 100, source: 'headless' })
    expect(await old).toBeNull()
  } finally {
    clearNativeWindowsConptyPty('pty-mid')
    await runtime.onPtyExit('pty-mid', 0)
  }
})

it('returns 2000 recovered lines with trailing CRLF and blank rows below the prompt', async () => {
  const { runtime, ready, read } = recoveredHistoryRuntime(1000)
  markNativeWindowsConptyPty('pty-history')
  try {
    await ready()
    runtime.onPtyData(
      'pty-history',
      `\r\n${Array.from({ length: 1100 }, (_, index) => `p${index + 1}`).join('\r\n')}\r\n\x1b[H\x1b[2J> `,
      2
    )
    const result = await read()
    expect(result.tail).toEqual([
      ...Array.from({ length: 898 }, (_, index) => `h${index + 103}`),
      ...Array.from({ length: 24 }, (_, index) => `s${index + 1}`),
      ...Array.from({ length: 1077 }, (_, index) => `p${index + 1}`),
      '>'
    ])
    expect(result.tail).toHaveLength(2000)
    expect(result.limited).toBe(false)
  } finally {
    clearNativeWindowsConptyPty('pty-history')
    await runtime.onPtyExit('pty-history', 0)
  }
})

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
