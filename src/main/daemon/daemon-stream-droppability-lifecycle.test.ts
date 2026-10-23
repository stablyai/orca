import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonServer } from './daemon-server'
import type { ConnectedDaemonClient } from './daemon-client-connections'
import type { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import type { BackgroundTransientFactRelay } from './daemon-background-transient-facts'
import type { PendingStreamDataBatch } from './daemon-stream-keep-tail-drop'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { DaemonRequest } from './types'

type MockSubprocess = SubprocessHandle & {
  emitData(data: string): void
  emitExit(code: number): void
}

type DaemonLifecyclePrivate = {
  connections: { clients: Map<string, ConnectedDaemonClient> }
  host: { getPartialEscapeTailAnsi(sessionId: string): string }
  requestRouter: {
    route(clientId: string, request: DaemonRequest): Promise<unknown>
  }
  streamDataBatcher: DaemonStreamDataBatcher
  transientFactRelay: BackgroundTransientFactRelay
  attachments: { clientIdBySessionId: Map<string, string> }
}

function createMockSubprocess(): MockSubprocess {
  let onData: ((data: string) => void) | undefined
  let onExit: ((code: number) => void) | undefined
  return {
    pid: 55_555,
    getForegroundProcess: () => null,
    write: vi.fn(),
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
    },
    emitExit(code) {
      onExit?.(code)
    }
  }
}

function createServerHarness() {
  const subprocesses: MockSubprocess[] = []
  const unique = randomUUID()
  const server = new DaemonServer({
    socketPath: join(tmpdir(), `orca-droppability-${unique}.sock`),
    tokenPath: join(tmpdir(), `orca-droppability-${unique}.token`),
    spawnSubprocess: () => {
      const subprocess = createMockSubprocess()
      subprocesses.push(subprocess)
      return subprocess
    }
  })
  return {
    server,
    daemon: server as unknown as DaemonLifecyclePrivate,
    subprocesses
  }
}

function addClient(
  daemon: DaemonLifecyclePrivate,
  writableLength = 0
): Socket & { write: ReturnType<typeof vi.fn>; writableLength: number } {
  const controlSocket = { destroy: vi.fn() } as unknown as Socket
  const streamSocket = {
    destroyed: false,
    writableLength,
    destroy: vi.fn(),
    write: vi.fn(() => true)
  } as unknown as Socket & {
    write: ReturnType<typeof vi.fn>
    writableLength: number
  }
  daemon.connections.clients.set('client-1', {
    clientId: 'client-1',
    controlSocket,
    streamSocket,
    authenticatedPairEstablished: true
  })
  return streamSocket
}

function pendingBatch(batcher: DaemonStreamDataBatcher): PendingStreamDataBatch {
  const pending = (
    batcher as unknown as {
      pendingByClient: Map<string, PendingStreamDataBatch>
    }
  ).pendingByClient.get('client-1')
  if (!pending) {
    throw new Error('Missing client-1 stream batch')
  }
  return pending
}

describe('daemon stream droppability lifecycle', () => {
  let server: DaemonServer | undefined

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(async () => {
    await server?.shutdown()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('refreshes after every background mutation and before changed markers', async () => {
    const harness = createServerHarness()
    server = harness.server
    const { daemon } = harness
    addClient(daemon)
    daemon.attachments.clientIdBySessionId.set('session-toggle', 'client-1')
    vi.spyOn(daemon.host, 'getPartialEscapeTailAnsi').mockReturnValue('')
    const lifecycle: string[] = []
    vi.spyOn(daemon.streamDataBatcher, 'refreshSessionDroppability').mockImplementation(
      (sessionId) => {
        lifecycle.push(`refresh:${String(daemon.transientFactRelay.isBackgrounded(sessionId))}`)
      }
    )
    vi.spyOn(daemon.streamDataBatcher, 'enqueueControlEvent').mockImplementation(
      (_clientId, _sessionId, control) => {
        lifecycle.push(
          `marker:${String(
            control.event === 'sessionBackgroundMarker' && control.payload.background
          )}`
        )
      }
    )

    await daemon.requestRouter.route('client-1', {
      id: 'background',
      type: 'setSessionBackground',
      payload: { sessionId: 'session-toggle', background: true }
    })
    expect(lifecycle).toEqual(['refresh:true', 'marker:true'])

    lifecycle.length = 0
    await daemon.requestRouter.route('client-1', {
      id: 'duplicate-background',
      type: 'setSessionBackground',
      payload: { sessionId: 'session-toggle', background: true }
    })
    expect(lifecycle).toEqual(['refresh:true'])

    lifecycle.length = 0
    await daemon.requestRouter.route('client-1', {
      id: 'foreground',
      type: 'setSessionBackground',
      payload: { sessionId: 'session-toggle', background: false }
    })
    expect(lifecycle).toEqual(['refresh:false', 'marker:false'])
  })

  it('returns a provisional 2031 subscribe with the foreground handoff marker', async () => {
    const harness = createServerHarness()
    server = harness.server
    const { daemon } = harness
    addClient(daemon)
    daemon.attachments.clientIdBySessionId.set('session-toggle', 'client-1')
    daemon.transientFactRelay.setSessionBackground('session-toggle', true)
    daemon.transientFactRelay.onSessionData('session-toggle', '\x1b[?2031h\x1b[?')
    vi.spyOn(daemon.host, 'getPartialEscapeTailAnsi').mockReturnValue('\x1b[?')
    const enqueue = vi.spyOn(daemon.streamDataBatcher, 'enqueueControlEvent')

    await daemon.requestRouter.route('client-1', {
      id: 'foreground',
      type: 'setSessionBackground',
      payload: { sessionId: 'session-toggle', background: false }
    })

    expect(enqueue).toHaveBeenCalledWith(
      'client-1',
      'session-toggle',
      expect.objectContaining({
        event: 'sessionBackgroundMarker',
        payload: {
          background: false,
          scanSeedAnsi: '\x1b[?',
          mode2031PendingSubscribe: true,
          osc133ScanState: { carry: '', adjacentMarkers: '' }
        }
      })
    )
  })

  it('returns OSC 133 adjacency and partial carry in the foreground marker', async () => {
    const harness = createServerHarness()
    server = harness.server
    const { daemon } = harness
    addClient(daemon)
    daemon.attachments.clientIdBySessionId.set('session-toggle', 'client-1')
    daemon.transientFactRelay.setSessionBackground('session-toggle', true)
    daemon.transientFactRelay.onSessionData(
      'session-toggle',
      '\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D'
    )
    vi.spyOn(daemon.host, 'getPartialEscapeTailAnsi').mockReturnValue('\x1b]133;D')
    const enqueue = vi.spyOn(daemon.streamDataBatcher, 'enqueueControlEvent')

    await daemon.requestRouter.route('client-1', {
      id: 'foreground',
      type: 'setSessionBackground',
      payload: { sessionId: 'session-toggle', background: false }
    })

    expect(enqueue).toHaveBeenCalledWith(
      'client-1',
      'session-toggle',
      expect.objectContaining({
        event: 'sessionBackgroundMarker',
        payload: {
          background: false,
          scanSeedAnsi: '\x1b]133;D',
          osc133ScanState: { carry: '\x1b]133;D', adjacentMarkers: 'BC' }
        }
      })
    )
  })

  it('routes an attached session before refresh and emits its background marker after', async () => {
    const harness = createServerHarness()
    server = harness.server
    const { daemon } = harness
    addClient(daemon)
    daemon.transientFactRelay.setSessionBackground('session-attach', true)
    const lifecycle: string[] = []
    vi.spyOn(daemon.streamDataBatcher, 'refreshSessionDroppability').mockImplementation(
      (sessionId) => {
        lifecycle.push(
          `refresh:${daemon.attachments.clientIdBySessionId.get(sessionId) ?? 'unrouted'}`
        )
      }
    )
    vi.spyOn(daemon.streamDataBatcher, 'enqueueControlEvent').mockImplementation(
      (_clientId, _sessionId, control) => {
        lifecycle.push(`marker:${control.event}`)
      }
    )

    await daemon.requestRouter.route('client-1', {
      id: 'attach',
      type: 'createOrAttach',
      payload: { sessionId: 'session-attach', cols: 80, rows: 24 }
    })

    expect(lifecycle).toEqual(['refresh:client-1', 'marker:sessionBackgroundMarker'])
  })

  it('keeps app-zone adjacency when replacing an uninterrupted attachment', async () => {
    const harness = createServerHarness()
    server = harness.server
    const { daemon, subprocesses } = harness
    addClient(daemon)
    const attach = () =>
      daemon.requestRouter.route('client-1', {
        id: 'attach',
        type: 'createOrAttach',
        payload: { sessionId: 'session-reattach', cols: 80, rows: 24 }
      })
    await attach()
    daemon.transientFactRelay.setSessionBackground('session-reattach', true)
    subprocesses[0].emitData('\x1b]133;B\x07\x1b]133;C\x07')
    await attach()
    expect(daemon.transientFactRelay.getOsc133ScanState('session-reattach').adjacentMarkers).toBe(
      'BC'
    )
    const enqueue = vi.spyOn(daemon.streamDataBatcher, 'enqueueControlEvent')
    subprocesses[0].emitData('\x1b]133;D;0\x07')
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('does not carry app-zone adjacency across detached output and reattachment', async () => {
    const harness = createServerHarness()
    server = harness.server
    const { daemon, subprocesses } = harness
    addClient(daemon)
    await daemon.requestRouter.route('client-1', {
      id: 'attach',
      type: 'createOrAttach',
      payload: { sessionId: 'session-reattach', cols: 80, rows: 24 }
    })
    daemon.transientFactRelay.setSessionBackground('session-reattach', true)
    subprocesses[0].emitData('\x1b]133;B\x07\x1b]133;C\x07')
    expect(daemon.transientFactRelay.getOsc133ScanState('session-reattach').adjacentMarkers).toBe(
      'BC'
    )
    await daemon.requestRouter.route('client-1', {
      id: 'detach',
      type: 'detach',
      payload: { sessionId: 'session-reattach' }
    })
    subprocesses[0].emitData('unobserved output')
    await daemon.requestRouter.route('client-1', {
      id: 'reattach',
      type: 'createOrAttach',
      payload: { sessionId: 'session-reattach', cols: 80, rows: 24 }
    })
    expect(daemon.transientFactRelay.getOsc133ScanState('session-reattach')).toEqual({
      carry: '',
      adjacentMarkers: ''
    })
    const enqueue = vi.spyOn(daemon.streamDataBatcher, 'enqueueControlEvent')
    subprocesses[0].emitData('\x1b]133;D;0\x07')
    expect(enqueue).toHaveBeenCalledWith(
      'client-1',
      'session-reattach',
      expect.objectContaining({
        event: 'transientFact',
        payload: { kind: 'command-finished', exitCode: 0 }
      })
    )
  })

  it('invalidates droppable membership for final output held behind a deep socket', async () => {
    const harness = createServerHarness()
    server = harness.server
    const { daemon, subprocesses } = harness
    addClient(daemon, 128 * 1024)
    daemon.transientFactRelay.setSessionBackground('session-exit', true)

    await daemon.requestRouter.route('client-1', {
      id: 'attach',
      type: 'createOrAttach',
      payload: { sessionId: 'session-exit', cols: 80, rows: 24 }
    })
    const subprocess = subprocesses[0]
    subprocess.emitData('final-output'.repeat(1024))
    expect(pendingBatch(daemon.streamDataBatcher).droppableQueuedSessionIds).toContain(
      'session-exit'
    )

    subprocess.emitExit(42)

    const batch = pendingBatch(daemon.streamDataBatcher)
    expect(batch.droppableQueuedSessionIds).not.toContain('session-exit')
    expect(batch.queuedCharsBySession.get('session-exit')).toBeGreaterThan(0)
    expect(batch.queue.at(-1)?.control).toMatchObject({
      event: 'exit',
      payload: { code: 42 }
    })
    expect(daemon.transientFactRelay.isBackgrounded('session-exit')).toBe(false)
    expect(daemon.attachments.clientIdBySessionId.has('session-exit')).toBe(false)
  })
})
