/**
 * A phone subscribing to an idle reattached PTY must get its first snapshot on the phone grid.
 *
 * Harness: real OrcaRuntimeService + real legacy `terminal.subscribe`. After a relaunch the
 * reattach skips seeding the host model because a pane is mounted; the PTY then emits no byte
 * (an agent waiting for input), and the pane, hidden in another workspace, answers its
 * serializer at desktop size.
 */
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { RpcDispatcher } from './rpc/dispatcher'
import type { RpcRequest } from './rpc/core'
import { TERMINAL_METHODS } from './rpc/methods/terminal'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText
} from '../../shared/terminal-stream-protocol'
import { HeadlessEmulator } from '../daemon/headless-emulator'

const WORKTREE_ID = 'repo-1::/tmp/wt'
const PTY_ID = `${WORKTREE_ID}@@9c8d7e6f`
const DESKTOP = { cols: 200, rows: 50 }
const PHONE = { cols: 47, rows: 40 }
const LONG_LINE = 'A'.repeat(120)
const EXPECTED_PHONE_ROWS = ['A'.repeat(47), 'A'.repeat(47), 'A'.repeat(26), '$ prompt']

type RuntimeInternals = {
  recordPtyWorktree: (ptyId: string, worktreeId: string, state?: { connected?: boolean }) => unknown
  issuePtyHandle: (pty: unknown) => string
  providerSnapshotPreferredPtys: Set<string>
}

function internals(runtime: OrcaRuntimeService): RuntimeInternals {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test reaches protected members the runtime defines.
  return runtime as unknown as RuntimeInternals
}

async function screenOn(grid: { cols: number; rows: number }): Promise<string> {
  const emulator = new HeadlessEmulator({ ...grid, scrollback: 1000 })
  try {
    await emulator.write(`${LONG_LINE}\r\n$ prompt`)
    const snapshot = emulator.getSnapshot()
    return snapshot.rehydrateSequences + snapshot.snapshotAnsi
  } finally {
    emulator.dispose()
  }
}

function setup(opts: { paneMounted: boolean; providerSnapshot?: boolean }) {
  const sizes = new Map([[PTY_ID, { ...DESKTOP }]])
  const serializeBuffer = vi.fn(async () =>
    opts.paneMounted ? { data: await screenOn(DESKTOP), ...DESKTOP } : null
  )
  const runtime = new OrcaRuntimeService()
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: (ptyId: string) => sizes.get(ptyId) ?? null,
    resize: (ptyId: string, cols: number, rows: number) => {
      sizes.set(ptyId, { cols, rows })
      return true
    },
    hasRendererSerializer: () => opts.paneMounted,
    getRendererSerializerGeneration: () => 1,
    waitForRendererSerializer: async () => false,
    serializeBuffer,
    // The daemon resizes its model with the PTY.
    serializeProviderBuffer: async (ptyId: string) => {
      const grid = sizes.get(ptyId) ?? DESKTOP
      return opts.providerSnapshot
        ? { data: await screenOn(grid), ...grid, seq: 0, source: 'headless' as const }
        : null
    }
  })
  const requestMount = vi.spyOn(runtime, 'requestRendererTerminalTabMount').mockReturnValue(false)
  const record = internals(runtime).recordPtyWorktree(PTY_ID, WORKTREE_ID, { connected: true })
  const handle = internals(runtime).issuePtyHandle(record)
  return { runtime, handle, sizes, serializeBuffer, requestMount }
}

function subscribePhone(runtime: OrcaRuntimeService, handle: string) {
  const frames: Uint8Array<ArrayBufferLike>[] = []
  const controller = new AbortController()
  const request: RpcRequest = {
    id: 'req-phone',
    authToken: 'tok',
    method: 'terminal.subscribe',
    params: {
      terminal: handle,
      client: { id: 'phone-1', type: 'mobile' },
      viewport: PHONE,
      capabilities: { terminalBinaryStream: 1 }
    }
  }
  const done = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS }).dispatchStreaming(
    request,
    () => {},
    {
      connectionId: 'conn-phone',
      signal: controller.signal,
      sendBinary: (bytes) => {
        frames.push(bytes)
      },
      registerBinaryStreamHandler: () => () => {}
    }
  )
  const decoded = () => frames.flatMap((bytes) => decodeTerminalStreamFrame(bytes) ?? [])
  const snapshot = () => {
    const start = decoded().find((frame) => frame.opcode === TerminalStreamOpcode.SnapshotStart)
    const meta = start
      ? decodeTerminalStreamJson<{ cols: number; rows: number }>(start.payload)
      : null
    if (!meta) {
      return null
    }
    const data = decoded()
      .filter((frame) => frame.opcode === TerminalStreamOpcode.SnapshotChunk)
      .map((frame) => decodeTerminalStreamText(frame.payload))
      .join('')
    return { cols: meta.cols, rows: meta.rows, data }
  }
  const close = async () => {
    runtime.cleanupSubscription(`${handle}:phone-1`)
    controller.abort()
    await done.catch(() => {})
  }
  return { snapshot, close }
}

/** What a phone xterm sized to the frame's declared grid shows after replaying it. */
async function paintedRows(snapshot: { cols: number; rows: number; data: string }) {
  const emulator = new HeadlessEmulator({ cols: snapshot.cols, rows: snapshot.rows, scrollback: 0 })
  try {
    await emulator.write(snapshot.data)
    return emulator.getVisibleLines().map((line) => line.trimEnd())
  } finally {
    emulator.dispose()
  }
}

async function firstSnapshot(runtime: OrcaRuntimeService, handle: string) {
  const subscription = subscribePhone(runtime, handle)
  await vi.waitFor(() => expect(subscription.snapshot()).not.toBeNull())
  const snapshot = subscription.snapshot()
  await subscription.close()
  if (!snapshot) {
    throw new Error('no snapshot frame')
  }
  return snapshot
}

describe('phone subscribe to an idle PTY whose hidden pane sits at desktop size', () => {
  it('serves the first snapshot from a host model hydrated onto the phone grid', async () => {
    const { runtime, handle, sizes } = setup({ paneMounted: true })
    expect(runtime.hasHeadlessTerminalState(PTY_ID)).toBe(false)

    const snapshot = await firstSnapshot(runtime, handle)

    expect(sizes.get(PTY_ID)).toEqual(PHONE)
    expect({ cols: snapshot.cols, rows: snapshot.rows }).toEqual(PHONE)
    expect((await paintedRows(snapshot)).slice(0, 4)).toEqual(EXPECTED_PHONE_ROWS)
    expect(runtime.hasHeadlessTerminalState(PTY_ID)).toBe(true)
  })

  it('serves the phone grid when a reattach left the restored snapshot preferred', async () => {
    const { runtime, handle } = setup({ paneMounted: true, providerSnapshot: true })
    // A continued daemon generation marks the model unsafe until a full snapshot arrives.
    internals(runtime).providerSnapshotPreferredPtys.add(PTY_ID)

    const snapshot = await firstSnapshot(runtime, handle)

    expect({ cols: snapshot.cols, rows: snapshot.rows }).toEqual(PHONE)
    expect((await paintedRows(snapshot)).slice(0, 4)).toEqual(EXPECTED_PHONE_ROWS)
    const resubscribed = await firstSnapshot(runtime, handle)
    expect({ cols: resubscribed.cols, rows: resubscribed.rows }).toEqual(PHONE)
  })

  it('keeps serving the model on resubscribe without re-reading the pane', async () => {
    const { runtime, handle, serializeBuffer } = setup({ paneMounted: true })
    await firstSnapshot(runtime, handle)
    const panesReadForFirst = serializeBuffer.mock.calls.length

    const snapshot = await firstSnapshot(runtime, handle)

    expect({ cols: snapshot.cols, rows: snapshot.rows }).toEqual(PHONE)
    expect((await paintedRows(snapshot)).slice(0, 4)).toEqual(EXPECTED_PHONE_ROWS)
    expect(serializeBuffer.mock.calls.length).toBe(panesReadForFirst)
  })

  it('chains a live repaint after the hydrated seed', async () => {
    const { runtime, handle } = setup({ paneMounted: true })
    await firstSnapshot(runtime, handle)
    runtime.onPtyData(PTY_ID, '\r\n$ repainted', Date.now())

    const snapshot = await firstSnapshot(runtime, handle)

    expect((await paintedRows(snapshot)).slice(0, 5)).toEqual([
      ...EXPECTED_PHONE_ROWS,
      '$ repainted'
    ])
  })

  it('leaves a PTY with no pane serializer to the renderer mount path', async () => {
    const { runtime, handle, requestMount } = setup({ paneMounted: false })

    const subscription = subscribePhone(runtime, handle)
    await vi.waitFor(() => expect(subscription.snapshot()).not.toBeNull(), { timeout: 5_000 })
    await subscription.close()

    expect(requestMount).toHaveBeenCalledTimes(1)
    expect(runtime.hasHeadlessTerminalState(PTY_ID)).toBe(false)
  })
})
