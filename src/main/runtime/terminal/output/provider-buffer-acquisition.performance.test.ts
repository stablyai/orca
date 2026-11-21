// Perf contract (#46516): delayed screen reads and overlapping replays duplicated provider requests.
import { afterEach, expect, it, vi } from 'vitest'
import { getLocalPtyProvider, setLocalPtyProvider } from '../../../ipc/pty/provider/registry'
import { serializeProviderBufferFromRuntimeController } from '../../../ipc/pty/runtime/operations'
import { LocalPtyProvider } from '../../../providers/local-pty/local-pty-provider'
import type {
  PtyProviderBufferSnapshot,
  PtyProviderBufferSnapshotOptions
} from '../../../providers/pty/provider-contract'
import { OrcaRuntimeService } from '../../orca-runtime'

const ANSI_FRAME: PtyProviderBufferSnapshot = {
  data: '\x1b[?1049hLegacy screen',
  cols: 80,
  rows: 24,
  seq: 900,
  source: 'headless',
  alternateScreen: true
}
const PROJECTED_FRAME: PtyProviderBufferSnapshot = {
  ...ANSI_FRAME,
  data: '',
  visibleProjection: { lines: ['Projected screen'] }
}

const previousProvider = getLocalPtyProvider()
afterEach(() => {
  setLocalPtyProvider(previousProvider)
  vi.useRealTimers()
})

function startTerminals(
  count: number,
  getBufferSnapshot: (
    id: string,
    opts?: PtyProviderBufferSnapshotOptions
  ) => Promise<PtyProviderBufferSnapshot>
) {
  setLocalPtyProvider(Object.assign(new LocalPtyProvider(), { getBufferSnapshot }))
  const runtime = new OrcaRuntimeService(null)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    serializeProviderBuffer: serializeProviderBufferFromRuntimeController
  })
  const terminals = Array.from({ length: count }, (_, index) => {
    const ptyId = `provider-buffer-${index}`
    const handle = runtime.preAllocateHandleForPty(ptyId)
    runtime.registerPty(ptyId, 'repo::/worktree')
    runtime.synchronizePtyOutputSequenceFromProvider(ptyId, { value: 900, generation: 'continued' })
    return { ptyId, handle }
  })
  return { runtime, terminals }
}

it.each([
  [2, 2],
  [20, 20]
])('bounds a burst of %i slow screen reads to %i provider requests', async (count, requests) => {
  vi.useFakeTimers()
  const frame = Promise.withResolvers<PtyProviderBufferSnapshot>()
  const getBufferSnapshot = vi.fn(async (_ptyId: string, opts?: PtyProviderBufferSnapshotOptions) =>
    opts?.visibleProjection ? frame.promise : ANSI_FRAME
  )
  const { runtime, terminals } = startTerminals(count, getBufferSnapshot)

  const reads = terminals.map(({ handle }) => runtime.readTerminal(handle, { screen: true }))
  await vi.advanceTimersByTimeAsync(751)
  frame.resolve(PROJECTED_FRAME)
  const screens = await Promise.all(reads)
  expect(getBufferSnapshot).toHaveBeenCalledTimes(requests)
  for (const { ptyId } of terminals) {
    expect(getBufferSnapshot).toHaveBeenCalledWith(ptyId, {
      scrollbackRows: 0,
      visibleProjection: true
    })
  }
  for (const screen of screens) {
    expect(screen).toMatchObject({ source: 'screen', tail: ['Projected screen'] })
  }
})

it('joins a pending replay with scrollback before projection support is known', async () => {
  vi.useFakeTimers()
  const frame = Promise.withResolvers<PtyProviderBufferSnapshot>()
  const getBufferSnapshot = vi.fn(async (_ptyId: string, opts?: PtyProviderBufferSnapshotOptions) =>
    opts?.visibleProjection ? PROJECTED_FRAME : frame.promise
  )
  const {
    runtime,
    terminals: [{ ptyId, handle }]
  } = startTerminals(1, getBufferSnapshot)

  const replay = runtime.serializeAuthoritativeTerminalBuffer(ptyId, { scrollbackRows: 50 })
  const visible = runtime.readTerminal(handle, { screen: true })
  await vi.advanceTimersByTimeAsync(0)
  frame.resolve({ ...ANSI_FRAME, scrollbackAnsi: 'Previous output\r\n' })
  await vi.advanceTimersByTimeAsync(20)

  await expect(visible).resolves.toMatchObject({ source: 'screen', tail: ['Legacy screen'] })
  await expect(replay).resolves.toMatchObject({ scrollbackAnsi: 'Previous output\r\n' })
  expect(getBufferSnapshot).toHaveBeenCalledExactlyOnceWith(ptyId, { scrollbackRows: 50 })
})

it('shares one legacy provider request when a visible read and a zero-row replay overlap', async () => {
  vi.useFakeTimers()
  const frame = Promise.withResolvers<PtyProviderBufferSnapshot>()
  const getBufferSnapshot = vi
    .fn<
      (id: string, opts?: PtyProviderBufferSnapshotOptions) => Promise<PtyProviderBufferSnapshot>
    >()
    .mockResolvedValueOnce(ANSI_FRAME)
    .mockReturnValue(frame.promise)
  const {
    runtime,
    terminals: [{ ptyId, handle }]
  } = startTerminals(1, getBufferSnapshot)

  const first = runtime.readTerminal(handle, { screen: true })
  await vi.advanceTimersByTimeAsync(20)
  await expect(first).resolves.toMatchObject({ tail: ['Legacy screen'] })
  expect(getBufferSnapshot).toHaveBeenCalledWith(ptyId, {
    scrollbackRows: 0,
    visibleProjection: true
  })
  getBufferSnapshot.mockClear()

  runtime.onPtyData(ptyId, 'next', Date.now())
  const visible = runtime.readTerminal(handle, { screen: true })
  await vi.advanceTimersByTimeAsync(0)
  const replay = runtime.serializeAuthoritativeTerminalBuffer(ptyId, { scrollbackRows: 0 })
  frame.resolve({ ...ANSI_FRAME, seq: 904 })
  await vi.advanceTimersByTimeAsync(20)

  await expect(visible).resolves.toMatchObject({ source: 'screen', tail: ['Legacy screen'] })
  await expect(replay).resolves.toMatchObject({ data: '\x1b[?1049hLegacy screen' })
  expect(getBufferSnapshot).toHaveBeenCalledExactlyOnceWith(ptyId, { scrollbackRows: 0 })
})
