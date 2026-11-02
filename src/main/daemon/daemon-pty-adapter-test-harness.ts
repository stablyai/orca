import type { DaemonStreamSource } from './daemon-client-ndjson-readers'
import type { PtyDataEvent } from '../providers/pty-provider-events'
import * as streamFraming from './daemon-stream-binary-framing'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import { DaemonClient } from './client'
import { expect, onTestFinished, vi, type Mock } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonPtyAdapterOptions } from './daemon-pty-runtime-state'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { DaemonFileLog } from './daemon-file-log'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'

export type SpawnSubprocess = ConstructorParameters<typeof DaemonServer>[0]['spawnSubprocess']

export type DaemonAdapterHarness = {
  dir: string
  socketPath: string
  tokenPath: string
  server: DaemonServer
  adapter: DaemonPtyAdapter
  daemonLog: DaemonFileLog
  daemonLogEvents: string[]
}

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'daemon-adapter-test-'))
}

export function createMockSubprocess(dataOnSubscribe?: string): SubprocessHandle & {
  write: ReturnType<typeof vi.fn<(data: string) => void>>
  pause: ReturnType<typeof vi.fn<() => void>>
  resume: ReturnType<typeof vi.fn<() => void>>
  confirmShellForeground: ReturnType<typeof vi.fn<() => Promise<boolean>>>
  _simulateData: (data: string) => void
  _simulateExit: (code: number, cause?: TerminalExitCause) => void
} {
  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number, cause?: TerminalExitCause) => void) | null = null
  return {
    // getCwd falls back to OS lookup; keep the fake PID outside the real process range.
    pid: 999_999_999,
    getForegroundProcess: vi.fn(() => null),
    confirmShellForeground: vi.fn(async () => false),
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn<() => void>(),
    resume: vi.fn<() => void>(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 5)),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => {
      setTimeout(() => onExitCb?.(137), 5)
    }),
    signal: vi.fn(),
    onData(cb) {
      onDataCb = cb
      if (dataOnSubscribe) {
        cb(dataOnSubscribe)
      }
    },
    onExit(cb) {
      onExitCb = cb
    },
    dispose: vi.fn(),
    _simulateData(data: string) {
      onDataCb?.(data)
    },
    _simulateExit(code: number, cause?: TerminalExitCause) {
      onExitCb?.(code, cause)
    }
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out')
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Boots a real daemon server over a temp socket plus a lazily-connecting adapter. */
export async function startDaemonAdapterHarness(
  spawnSubprocess: SpawnSubprocess,
  adapterOptions: Pick<
    DaemonPtyAdapterOptions,
    'readRunningWslDistros' | 'historyPath' | 'wslBridgeBootIdentity'
  > = {},
  serverOptions: { onPtySessionExit?: (sessionId: string) => void } = {}
): Promise<DaemonAdapterHarness> {
  const dir = createTestDir()
  const socketPath = getDaemonSocketPath(dir)
  const tokenPath = join(dir, 'test.token')
  const daemonLogEvents: string[] = []
  const daemonLog: DaemonFileLog = {
    log: (event) => daemonLogEvents.push(event),
    close() {}
  }
  const server = new DaemonServer({
    socketPath,
    tokenPath,
    log: daemonLog,
    spawnSubprocess,
    ...serverOptions
  })
  await server.start()
  const adapter = new DaemonPtyAdapter({ socketPath, tokenPath, ...adapterOptions })
  return { dir, socketPath, tokenPath, server, adapter, daemonLog, daemonLogEvents }
}

export function expectActualSemanticSource(
  event: PtyDataEvent,
  provider: DaemonPtyAdapter,
  source: DaemonStreamSource
): void {
  expect(event.semanticSource?.provider).toBe(provider)
  expect(event.semanticSource?.stream).toBe(source.owner)
  expect(event.semanticSource?.terminalState).toBe(source.terminalState)
}

export function captureActualDataSource() {
  let source: Parameters<Parameters<DaemonClient['onEvent']>[0]>[1]
  const onEvent = DaemonClient.prototype.onEvent
  const subscription = vi.spyOn(DaemonClient.prototype, 'onEvent').mockImplementation(function (
    this: DaemonClient,
    listener
  ) {
    return onEvent.call(this, (event, currentSource) => {
      if (
        typeof event === 'object' &&
        event !== null &&
        'event' in event &&
        event.event === 'data'
      ) {
        source = currentSource
      }
      listener(event, currentSource)
    })
  })
  onTestFinished(() => subscription.mockRestore())
  return () => {
    if (!source) {
      throw new Error('Expected actual emitting daemon stream')
    }
    return source
  }
}

export function expectClassifiedStartupData(
  onData: Mock<(event: PtyDataEvent) => void>,
  adapter: DaemonPtyAdapter,
  actualSource: ReturnType<typeof captureActualDataSource>,
  id: string,
  query: string
): void {
  expect(onData).toHaveBeenCalledWith({
    id,
    data: '',
    sequenceChars: query.length,
    seq: query.length,
    transformed: true,
    semanticSource: {
      provider: adapter,
      stream: actualSource().owner,
      terminalState: actualSource().terminalState
    }
  })
  expectActualSemanticSource(onData.mock.calls[0][0], adapter, actualSource())
  expectActualSemanticSource(onData.mock.calls[1][0], adapter, actualSource())
  expect(onData).toHaveBeenCalledTimes(2)
  expect(onData).toHaveBeenLastCalledWith({
    id,
    data: 'prompt',
    semanticSource: {
      provider: adapter,
      stream: actualSource().owner,
      terminalState: actualSource().terminalState
    }
  })
}

export type DaemonAdapterBurstOperationInput = {
  size: number
  adapter: DaemonPtyAdapter
  server: DaemonServer
  emitData: (data: string) => void
}

export async function expectDaemonAdapterBurstOperations({
  size,
  adapter,
  server,
  emitData
}: DaemonAdapterBurstOperationInput): Promise<void> {
  const actualSource = captureActualDataSource()
  const delivered: PtyDataEvent[] = []
  adapter.onData((event) => delivered.push(event))
  const { id } = await adapter.spawn({ cols: 80, rows: 24 })
  const batcher: unknown = Object.getOwnPropertyDescriptor(server, 'streamDataBatcher')?.value
  if (!(batcher instanceof DaemonStreamDataBatcher)) {
    throw new Error('Expected actual daemon batcher')
  }
  const enqueue = vi.spyOn(batcher, 'enqueue')
  const serialize = vi.spyOn(streamFraming, 'encodeBinaryStreamDataFrame')
  try {
    for (let index = 0; index < size; index++) {
      emitData('x')
    }
    expect(enqueue).toHaveBeenCalledTimes(size)
    expect(enqueue.mock.calls.every(([, session, bytes]) => session === id && bytes === 'x')).toBe(
      true
    )
    await waitFor(() => delivered.length > 0)
    expectActualSemanticSource(delivered[0], adapter, actualSource())
    expect(delivered).toEqual([
      {
        id,
        data: 'x'.repeat(size),
        semanticSource: {
          provider: adapter,
          stream: actualSource().owner,
          terminalState: actualSource().terminalState
        }
      }
    ])
    expect(serialize).toHaveBeenCalledExactlyOnceWith(id, 'x'.repeat(size), {}, expect.any(Number))
    expect(batcher.queuedCharsForClient(enqueue.mock.calls[0][0])).toBe(0)
  } finally {
    enqueue.mockRestore()
    serialize.mockRestore()
  }
}

export type DaemonDataObservation = (id: string, data: string) => Promise<void>

export function observeDaemonAdapterData(adapter: DaemonPtyAdapter): DaemonDataObservation {
  const actualSource = captureActualDataSource()
  const dataPayloads: PtyDataEvent[] = []
  adapter.onData((payload) => dataPayloads.push(payload))
  return async (id, data) => {
    await waitFor(() => dataPayloads.length > 0)
    expectActualSemanticSource(dataPayloads[0], adapter, actualSource())
    expect(dataPayloads).toEqual([
      {
        id,
        data,
        semanticSource: {
          provider: adapter,
          stream: actualSource().owner,
          terminalState: actualSource().terminalState
        }
      }
    ])
  }
}

export function observeClassifiedStartupData(adapter: DaemonPtyAdapter) {
  const actualSource = captureActualDataSource()
  const onData = vi.fn<(event: PtyDataEvent) => void>()
  adapter.onData(onData)
  return { onData, actualSource }
}
