// Perf contract (#46516): overlapping screen reads and replays duplicated requests or live mode scans.
import { afterEach, expect, it, vi } from 'vitest'
import type { HelloResponse } from '../../../daemon/protocol/daemon-hello-protocol'
import { getLocalPtyProvider, setLocalPtyProvider } from '../../../ipc/pty/provider/registry'
import {
  serializeProviderBufferFromRuntimeController,
  supportsVisibleProjectionSnapshotFromRuntimeController
} from '../../../ipc/pty/runtime/provider-buffer-snapshot'
import { LocalPtyProvider } from '../../../providers/local-pty/local-pty-provider'
import type {
  PtyProviderBufferSnapshot,
  PtyProviderBufferSnapshotOptions
} from '../../../providers/pty/provider-contract'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal/protocol/input-modes/terminal-kitty-keyboard-mode-tracker'
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
  hello: Pick<HelloResponse, 'visibleProjectionSnapshots'>,
  getBufferSnapshot: (
    id: string,
    opts?: PtyProviderBufferSnapshotOptions
  ) => Promise<PtyProviderBufferSnapshot>
) {
  setLocalPtyProvider(
    Object.assign(new LocalPtyProvider(), {
      getBufferSnapshot,
      supportsVisibleProjectionSnapshot: () => hello.visibleProjectionSnapshots === true
    })
  )
  const runtime = new OrcaRuntimeService(null)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    serializeProviderBuffer: serializeProviderBufferFromRuntimeController,
    supportsVisibleProjectionSnapshot: supportsVisibleProjectionSnapshotFromRuntimeController
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
  const { runtime, terminals } = startTerminals(
    count,
    { visibleProjectionSnapshots: true },
    getBufferSnapshot
  )

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

it('joins a pending ANSI replay with scrollback on a provider that supports projection', async () => {
  vi.useFakeTimers()
  const frame = Promise.withResolvers<PtyProviderBufferSnapshot>()
  const getBufferSnapshot = vi.fn(async (_ptyId: string, opts?: PtyProviderBufferSnapshotOptions) =>
    opts?.visibleProjection ? PROJECTED_FRAME : frame.promise
  )
  const {
    runtime,
    terminals: [{ ptyId, handle }]
  } = startTerminals(1, { visibleProjectionSnapshots: true }, getBufferSnapshot)

  const replay = runtime.serializeAuthoritativeTerminalBuffer(ptyId, { scrollbackRows: 50 })
  const visible = runtime.readTerminal(handle, { screen: true })
  await vi.advanceTimersByTimeAsync(0)
  frame.resolve({ ...ANSI_FRAME, scrollbackAnsi: 'Previous output\r\n' })
  await vi.advanceTimersByTimeAsync(20)

  await expect(visible).resolves.toMatchObject({ source: 'screen', tail: ['Legacy screen'] })
  await expect(replay).resolves.toMatchObject({ scrollbackAnsi: 'Previous output\r\n' })
  expect(getBufferSnapshot).toHaveBeenCalledExactlyOnceWith(ptyId, { scrollbackRows: 50 })
})

it.each([
  [100, 200],
  [1000, 2000]
])(
  'scans two live chunks once per PTY across %i overlapping screen and replay pairs',
  async (count, scans) => {
    vi.useFakeTimers()
    const screenFrame = Promise.withResolvers<PtyProviderBufferSnapshot>()
    const replayFrame = Promise.withResolvers<PtyProviderBufferSnapshot>()
    const getBufferSnapshot = vi.fn((_ptyId: string, opts?: PtyProviderBufferSnapshotOptions) =>
      opts?.visibleProjection ? screenFrame.promise : replayFrame.promise
    )
    const { runtime, terminals } = startTerminals(
      count,
      { visibleProjectionSnapshots: true },
      getBufferSnapshot
    )

    const reads = terminals.map(({ handle }) => runtime.readTerminal(handle, { screen: true }))
    await vi.advanceTimersByTimeAsync(0)
    const replays = terminals.map(({ ptyId }) =>
      runtime.serializeAuthoritativeTerminalBuffer(ptyId, { scrollbackRows: 0 })
    )
    expect(getBufferSnapshot).toHaveBeenCalledTimes(scans)

    const scan = vi.spyOn(TerminalKittyKeyboardModeTracker.prototype, 'scan')
    try {
      for (const { ptyId } of terminals) {
        runtime.onPtyData(ptyId, '\x1b[', 1)
        runtime.onPtyData(ptyId, '31mLive output', 2)
      }
      expect(scan).toHaveBeenCalledTimes(scans)
    } finally {
      scan.mockRestore()
    }

    screenFrame.resolve({ ...PROJECTED_FRAME, seq: 1000 })
    replayFrame.resolve({ ...ANSI_FRAME, seq: 1000 })
    for (const screen of await Promise.all(reads)) {
      expect(screen).toMatchObject({ source: 'screen', tail: ['Projected screen'] })
    }
    for (const replay of await Promise.all(replays)) {
      expect(replay).toMatchObject({ data: '\x1b[?1049hLegacy screen' })
    }
  }
)

it.each([
  [2, 2],
  [20, 20]
])(
  'shares %i first screen reads with zero-row replays in %i requests after a daemon hello without the capability',
  async (count, requests) => {
    vi.useFakeTimers()
    const frame = Promise.withResolvers<PtyProviderBufferSnapshot>()
    const getBufferSnapshot = vi.fn(() => frame.promise)
    const { runtime, terminals } = startTerminals(count, {}, getBufferSnapshot)

    const reads = terminals.map(({ handle }) => runtime.readTerminal(handle, { screen: true }))
    await vi.advanceTimersByTimeAsync(0)
    expect(getBufferSnapshot).toHaveBeenCalledTimes(requests)
    const replays = terminals.map(({ ptyId }) =>
      runtime.serializeAuthoritativeTerminalBuffer(ptyId, { scrollbackRows: 0 })
    )
    frame.resolve(ANSI_FRAME)
    await vi.advanceTimersByTimeAsync(20)

    for (const screen of await Promise.all(reads)) {
      expect(screen).toMatchObject({ source: 'screen', tail: ['Legacy screen'] })
    }
    for (const replay of await Promise.all(replays)) {
      expect(replay).toMatchObject({ data: '\x1b[?1049hLegacy screen' })
    }
    expect(getBufferSnapshot).toHaveBeenCalledTimes(requests)
    for (const { ptyId } of terminals) {
      expect(getBufferSnapshot).toHaveBeenCalledWith(ptyId, { scrollbackRows: 0 })
    }
  }
)
