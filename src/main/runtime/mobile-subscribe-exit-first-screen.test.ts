import './rpc/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { RpcDispatcher } from './rpc/dispatcher'
import { TERMINAL_METHODS } from './rpc/methods/terminal/terminal'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText
} from '../../shared/terminal/stream/terminal-stream-protocol'
import { HeadlessEmulator } from '../daemon/emulation/headless-emulator'

const WORKTREE_ID = 'repo-1::/tmp/wt'
const PTY_ID = `${WORKTREE_ID}@@5e1f0a2b`
const GRID = { cols: 40, rows: 6 }

type RuntimeInternals = {
  recordPtyWorktree: (ptyId: string, worktreeId: string, state?: { connected?: boolean }) => unknown
  issuePtyHandle: (pty: unknown) => string
}

function internals(runtime: OrcaRuntimeService): RuntimeInternals {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test reaches protected members the runtime defines.
  return runtime as unknown as RuntimeInternals
}

async function paintedRows(cols: number, rows: number, data: string): Promise<string[]> {
  const emulator = new HeadlessEmulator({ cols, rows, scrollback: 0 })
  try {
    await emulator.write(data)
    return emulator.getVisibleLines().map((line) => line.trimEnd())
  } finally {
    emulator.dispose()
  }
}

function setup(controller: Partial<Parameters<OrcaRuntimeService['setPtyController']>[0]> = {}) {
  const runtime = new OrcaRuntimeService()
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => GRID,
    ...controller
  })
  const handle = internals(runtime).issuePtyHandle(
    internals(runtime).recordPtyWorktree(PTY_ID, WORKTREE_ID, { connected: true })
  )
  return { runtime, handle }
}

/** Subscribes a phone whose fit is still running when the PTY writes `lastOutput` and exits. */
async function subscribeThroughExit(
  runtime: OrcaRuntimeService,
  handle: string,
  capabilities: { outputAck?: number },
  lastOutput: string
) {
  let finishFit = (): void => {}
  const fit = vi
    .spyOn(runtime, 'handleMobileSubscribe')
    .mockImplementation(() => new Promise((resolve) => (finishFit = () => resolve(true))))
  const messages: string[] = []
  const frames: Uint8Array<ArrayBufferLike>[] = []
  const done = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS }).dispatchStreaming(
    {
      id: 'req-phone',
      authToken: 'tok',
      method: 'terminal.subscribe',
      params: {
        terminal: handle,
        client: { id: 'phone-1', type: 'mobile' },
        viewport: GRID,
        capabilities: { terminalBinaryStream: 1, ...capabilities }
      }
    },
    (message) => messages.push(message),
    {
      connectionId: 'conn-phone',
      sendBinary: (bytes) => {
        frames.push(bytes)
      },
      registerBinaryStreamHandler: () => () => {}
    }
  )
  await vi.waitFor(() => expect(fit).toHaveBeenCalled())
  if (lastOutput) {
    runtime.onPtyData(PTY_ID, lastOutput, 2_000)
  }
  await runtime.onPtyExit(PTY_ID, 2)
  finishFit()
  await done
  const decoded = frames.flatMap((bytes) => decodeTerminalStreamFrame(bytes) ?? [])
  return {
    results: messages.map((message) => JSON.parse(message).result?.type),
    snapshotMeta: () => {
      const start = decoded.find((frame) => frame.opcode === TerminalStreamOpcode.SnapshotStart)
      return start && decodeTerminalStreamJson<{ cols: number; rows: number }>(start.payload)
    },
    painted: () =>
      decoded
        .filter(
          (frame) =>
            frame.opcode === TerminalStreamOpcode.SnapshotChunk ||
            frame.opcode === TerminalStreamOpcode.Output
        )
        .map((frame) => decodeTerminalStreamText(frame.payload))
        .join('')
  }
}

describe('phone subscribe when the PTY exits while its first screen is publishing', () => {
  it.each([{ outputAck: 1 }, {}])(
    'sends the final screen before end (capabilities %o)',
    async (credit) => {
      const { runtime, handle } = setup()
      runtime.onPtyData(PTY_ID, '$ make\r\n', 1_000)

      const stream = await subscribeThroughExit(runtime, handle, credit, 'build failed\r\n')

      expect(stream.results).toEqual(['subscribed', 'end'])
      expect(stream.snapshotMeta()).toMatchObject(GRID)
      expect(await paintedRows(GRID.cols, GRID.rows, stream.painted())).toEqual([
        '$ make',
        'build failed',
        '',
        '',
        '',
        ''
      ])
      expect(runtime.hasHeadlessTerminalState(PTY_ID)).toBe(false)
    }
  )

  it('builds no model for the dead PTY when it had none and its pane is mounted', async () => {
    const { runtime, handle } = setup({
      hasRendererSerializer: () => true,
      getRendererSerializerGeneration: () => 1,
      waitForRendererSerializer: async () => true,
      serializeBuffer: async () => ({ data: '$ make\r\n', ...GRID })
    })
    vi.spyOn(runtime, 'requestRendererTerminalTabMount').mockReturnValue(false)
    expect(runtime.hasHeadlessTerminalState(PTY_ID)).toBe(false)

    const stream = await subscribeThroughExit(runtime, handle, {}, '')

    expect(stream.results).toEqual(['subscribed', 'end'])
    expect(runtime.hasHeadlessTerminalState(PTY_ID)).toBe(false)
  })

  it('still sends the renderer screen but builds no model when the PTY exits while it is read', async () => {
    let rendererReads = 0
    let finishRead = (): void => {}
    let readStarted = (): void => {}
    const stableReadStarted = new Promise<void>((resolve) => (readStarted = resolve))
    const { runtime, handle } = setup({
      hasRendererSerializer: () => true,
      getRendererSerializerGeneration: () => 1,
      waitForRendererSerializer: async () => true,
      serializeBuffer: async () => {
        rendererReads += 1
        // Hydration, the budgeted snapshot and the readiness probe come first; then the stable read.
        if (rendererReads === 1) {
          return { data: '', ...GRID }
        }
        if (rendererReads === 2) {
          return null
        }
        if (rendererReads === 3) {
          return { data: 'x', ...GRID }
        }
        readStarted()
        await new Promise<void>((resolve) => (finishRead = resolve))
        return { data: '$ make\r\nbuild failed\r\n', ...GRID, seq: 0 }
      }
    })
    vi.spyOn(runtime, 'requestRendererTerminalTabMount').mockReturnValue(false)
    vi.spyOn(runtime, 'handleMobileSubscribe').mockResolvedValue(true)
    const messages: string[] = []
    const frames: Uint8Array<ArrayBufferLike>[] = []
    const done = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS }).dispatchStreaming(
      {
        id: 'req-phone',
        authToken: 'tok',
        method: 'terminal.subscribe',
        params: {
          terminal: handle,
          client: { id: 'phone-1', type: 'mobile' },
          viewport: GRID,
          capabilities: { terminalBinaryStream: 1 }
        }
      },
      (message) => messages.push(message),
      {
        connectionId: 'conn-phone',
        sendBinary: (bytes) => {
          frames.push(bytes)
        },
        registerBinaryStreamHandler: () => () => {}
      }
    )
    await stableReadStarted
    await runtime.onPtyExit(PTY_ID, 0)
    finishRead()
    await done

    expect(messages.map((message) => JSON.parse(message).result?.type)).toEqual([
      'subscribed',
      'end'
    ])
    const snapshot = frames
      .flatMap((bytes) => decodeTerminalStreamFrame(bytes) ?? [])
      .filter((frame) => frame.opcode === TerminalStreamOpcode.SnapshotChunk)
      .map((frame) => decodeTerminalStreamText(frame.payload))
      .join('')
    expect((await paintedRows(GRID.cols, GRID.rows, snapshot)).slice(0, 2)).toEqual([
      '$ make',
      'build failed'
    ])
    expect(runtime.hasHeadlessTerminalState(PTY_ID)).toBe(false)
  })
})
