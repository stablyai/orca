import { assert, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty/provider-contract'

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

it.each([3, 900])(
  'rebuilds from a fresh capture on a silent stream even when its seq (%i) does not match this one',
  async (seq) => {
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => grid,
      serializeProviderBuffer: async () => ({
        data: '\x1b[H\x1b[2Jfresh',
        ...grid,
        seq,
        source: 'headless' as const
      })
    })
    try {
      runtime.onPtyData('pty-seq', 'stale\r\n', 1)
      runtime.notePtyDataGap('pty-seq', 9)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: OrcaRuntimeService inherits this protected method with exactly this signature.
      const headless = runtime as unknown as {
        serializeHeadlessTerminalBuffer(ptyId: string): Promise<{ data: string } | null>
      }
      const snapshot = await vi.waitFor(
        async () => {
          const rebuilt = await headless.serializeHeadlessTerminalBuffer('pty-seq')
          assert(rebuilt)
          return rebuilt
        },
        { timeout: 5_000 }
      )
      expect(await replay(snapshot, '')).toEqual(['fresh'])
    } finally {
      await runtime.onPtyExit('pty-seq', 0)
    }
  }
)

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
