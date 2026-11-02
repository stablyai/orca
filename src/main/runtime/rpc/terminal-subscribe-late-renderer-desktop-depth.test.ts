import './unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'
import { stubRuntime } from './terminal-multiplex-test-harness'

const request: RpcRequest = {
  id: 'req-late-renderer',
  authToken: 'tok',
  method: 'terminal.subscribe',
  params: {
    terminal: 'terminal-late-renderer',
    client: { id: 'phone-late-renderer', type: 'mobile' },
    capabilities: { terminalBinaryStream: 1 }
  }
}

afterEach(() => {
  vi.useRealTimers()
})

async function lateRendererRecovery(outputDuringDeepRead: boolean) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
  const registry = createSubscriptionRegistryDouble()
  let outputSequence = 5
  let rendererReady!: (ready: boolean) => void
  let mounted = false
  const serializeRendererTerminalBuffer = vi.fn(
    async (_ptyId: string, opts?: { scrollbackRows?: number }) => {
      if (!mounted) {
        return null
      }
      if (opts?.scrollbackRows === 5000) {
        if (outputDuringDeepRead) {
          outputSequence = 6
        }
        return { data: 'desktop history', cols: 80, rows: 24, seq: 5 }
      }
      return { data: 'phone history', cols: 80, rows: 24, seq: 5 }
    }
  )
  const replaceHeadlessTerminalFromRendererSnapshotForRecovery =
    vi.fn<(ptyId: string, seed: { data: string }) => void>()
  const runtime = stubRuntime({
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-late' }),
    hasHeadlessTerminalState: vi.fn(() => false),
    requestRendererTerminalTabMount: vi.fn(() => true),
    getRendererTerminalSerializerGenerationForHandle: vi.fn(() => 1),
    getRendererTerminalSerializerGeneration: vi.fn(() => 1),
    waitForRendererTerminalSerializer: vi.fn(
      () => new Promise<boolean>((resolve) => (rendererReady = resolve))
    ),
    getPtyOutputSequence: vi.fn(() => outputSequence),
    handleMobileSubscribe: vi.fn().mockResolvedValue(true),
    handleMobileUnsubscribe: vi.fn(),
    subscribeToTerminalData: vi.fn(() => vi.fn()),
    registerRemoteTerminalViewSubscriber: vi.fn(() => vi.fn()),
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi.fn().mockResolvedValue(null),
    serializeRendererTerminalBuffer,
    replaceHeadlessTerminalFromRendererSnapshotForRecovery,
    getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
    registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
    cleanupSubscription: vi.fn(registry.cleanupSubscription),
    waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
  })
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const dispatchPromise = dispatcher.dispatchStreaming(request, vi.fn(), {
    connectionId: 'conn-phone',
    sendBinary: (bytes) => {
      binaryFrames.push(bytes)
    },
    registerBinaryStreamHandler: vi.fn(() => vi.fn())
  })
  // The mount wait times out, so the late renderer arrives through the live recovery path.
  await vi.advanceTimersByTimeAsync(3_000)
  mounted = true
  rendererReady(true)
  const sentSnapshots = () =>
    binaryFrames
      .map((bytes) => decodeTerminalStreamFrame(bytes))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
      .map((frame) => decodeTerminalStreamText(frame!.payload))
  await vi.waitFor(() => expect(sentSnapshots()).toContain('phone history'))
  await vi.waitFor(() =>
    expect(serializeRendererTerminalBuffer).toHaveBeenLastCalledWith('pty-late', {
      scrollbackRows: 5000
    })
  )
  await vi.advanceTimersByTimeAsync(0)
  const seeds = replaceHeadlessTerminalFromRendererSnapshotForRecovery.mock.calls.map(
    ([, seed]) => seed.data
  )
  runtime.cleanupSubscription('terminal-late-renderer:phone-late-renderer')
  await dispatchPromise
  return { seeds, sent: sentSnapshots() }
}

describe('late renderer recovery keeps desktop history in main', () => {
  it('publishes the phone recovery, then deepens main to desktop depth', async () => {
    const { seeds, sent } = await lateRendererRecovery(false)
    expect(sent).toContain('phone history')
    expect(seeds).toEqual(['phone history', 'desktop history'])
  })

  it('still publishes the phone recovery when output lands during the deeper read', async () => {
    const { seeds, sent } = await lateRendererRecovery(true)
    expect(sent).toContain('phone history')
    expect(seeds).toEqual(['phone history'])
  })
})
