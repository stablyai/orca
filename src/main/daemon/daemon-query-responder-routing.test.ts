import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonServer } from './daemon-server'
import type { ConnectedDaemonClient } from './daemon-client-connections'
import type { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import type { PendingStreamDataBatch } from './daemon-stream-keep-tail-drop'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { DaemonRequest } from './types'
import { _resetDaemonTerminalViewAttributesForTest } from './daemon-view-attributes'

type MockSubprocess = SubprocessHandle & {
  write: ReturnType<typeof vi.fn<(data: string) => void>>
  emitData(data: string): void
}

type DaemonPrivate = {
  connections: { clients: Map<string, ConnectedDaemonClient> }
  requestRouter: { route(clientId: string, request: DaemonRequest): Promise<unknown> }
  streamDataBatcher: DaemonStreamDataBatcher
}

function createMockSubprocess(): MockSubprocess {
  let onData: ((data: string) => void) | undefined
  let onExit: ((code: number) => void) | undefined
  return {
    pid: 55_556,
    getForegroundProcess: () => null,
    write: vi.fn<(data: string) => void>(),
    resize: vi.fn(),
    kill: vi.fn(() => onExit?.(0)),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => onExit?.(137)),
    signal: vi.fn(),
    onData(callback) {
      onData = callback
    },
    onExit(callback) {
      onExit = callback
    },
    dispose: vi.fn(),
    emitData(data) {
      onData?.(data)
    }
  }
}

function createHarness() {
  const subprocesses: MockSubprocess[] = []
  const unique = randomUUID()
  const server = new DaemonServer({
    socketPath: join(tmpdir(), `orca-responder-${unique}.sock`),
    tokenPath: join(tmpdir(), `orca-responder-${unique}.token`),
    spawnSubprocess: () => {
      const subprocess = createMockSubprocess()
      subprocesses.push(subprocess)
      return subprocess
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test reads private daemon members that exist at runtime.
  const daemon = server as unknown as DaemonPrivate
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the daemon only touches these socket members.
  const controlSocket = { destroy: vi.fn() } as unknown as Socket
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the daemon only touches these socket members.
  const streamSocket = {
    destroyed: false,
    writableLength: 128 * 1024,
    destroy: vi.fn(),
    write: vi.fn(() => true)
  } as unknown as Socket
  daemon.connections.clients.set('client-1', {
    clientId: 'client-1',
    controlSocket,
    streamSocket,
    authenticatedPairEstablished: true
  })
  return { server, daemon, subprocesses }
}

function queuedStream(batcher: DaemonStreamDataBatcher): string[] {
  type BatcherQueues = { pendingByClient: Map<string, PendingStreamDataBatch> }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test reads the batcher's private queue.
  const queues = batcher as unknown as BatcherQueues
  const pending = queues.pendingByClient.get('client-1')
  return (pending?.queue ?? []).map((entry) => {
    if (entry.control?.event === 'sessionQueryResponderMarker') {
      return `marker:${String(entry.control.payload.responder)}`
    }
    return entry.control ? entry.control.event : `data:${entry.data}`
  })
}

describe('daemon query responder routing', () => {
  let server: DaemonServer | undefined

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(async () => {
    await server?.shutdown()
    _resetDaemonTerminalViewAttributesForTest()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('answers between its markers, which land in byte order', async () => {
    const harness = createHarness()
    server = harness.server
    const { daemon, subprocesses } = harness
    await daemon.requestRouter.route('client-1', {
      id: 'attach',
      type: 'createOrAttach',
      payload: { sessionId: 'session-q', cols: 80, rows: 24 }
    })
    const subprocess = subprocesses[0]
    subprocess.emitData('a\x1b[6n')

    await daemon.requestRouter.route('client-1', {
      id: 'delegate',
      type: 'setSessionQueryResponder',
      payload: { sessionId: 'session-q', responder: true }
    })
    subprocess.emitData('b\x1b[6n')
    await daemon.requestRouter.route('client-1', {
      id: 'take-back',
      type: 'setSessionQueryResponder',
      payload: { sessionId: 'session-q', responder: false }
    })
    subprocess.emitData('c\x1b[6n')

    expect(subprocess.write.mock.calls).toEqual([['\x1b[1;3R']])
    expect(queuedStream(daemon.streamDataBatcher).filter((entry) => entry !== 'data:')).toEqual([
      'data:a\x1b[6n',
      'marker:true',
      'data:b\x1b[6n',
      'marker:false',
      'data:c\x1b[6n'
    ])
  })

  it('confirms false for a session it does not own', async () => {
    const harness = createHarness()
    server = harness.server
    const { daemon } = harness
    await daemon.requestRouter.route('client-1', {
      id: 'attach',
      type: 'createOrAttach',
      payload: { sessionId: 'session-q', cols: 80, rows: 24 }
    })
    await daemon.requestRouter.route('client-1', {
      id: 'exit',
      type: 'kill',
      payload: { sessionId: 'session-q' }
    })
    await daemon.requestRouter.route('client-1', {
      id: 'delegate',
      type: 'setSessionQueryResponder',
      payload: { sessionId: 'session-q', responder: true }
    })
    expect(queuedStream(daemon.streamDataBatcher)).not.toContain('marker:true')
  })
})
