import './mock-descendant-sweep'
import { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { TerminalHost } from './terminal-host'
import { DaemonTerminalAdmission } from './daemon-terminal-admission'
import { DaemonPtySpawnPreparations } from './daemon-pty-spawn-preparations'
import { DaemonClientConnections } from './daemon-client-connections'
import { DaemonEndpointLifecycle } from './daemon-endpoint-lifecycle'
import { DaemonSessionAttachments } from './daemon-session-attachments'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import { BackgroundTransientFactRelay } from './daemon-background-transient-facts'
import { TerminalHistorySeedTransferRegistry } from './terminal-history-seed-transfer-registry'
import { createNoopDaemonFileLog } from './daemon-file-log'
import type { SubprocessHandle } from './session-subprocess-handle'

function slowExitSubprocess(): SubprocessHandle {
  let onExit: ((code: number) => void) | undefined
  return {
    pid: 4242,
    shellPath: '/bin/sh',
    getForegroundProcess: () => null,
    write: vi.fn(),
    resize: vi.fn(),
    kill: () => {
      setTimeout(() => onExit?.(0), 40).unref?.()
    },
    terminateOwnedTree: () => 'unavailable',
    forceKill: () => {
      setTimeout(() => onExit?.(137), 40).unref?.()
    },
    signal: vi.fn(),
    dispose: vi.fn(),
    onData: vi.fn(),
    onExit: (callback) => {
      onExit = callback
    }
  }
}

function admissionFor(host: TerminalHost, socket: Socket): DaemonTerminalAdmission {
  const log = createNoopDaemonFileLog()
  const unexpected = (): never => {
    throw new Error('unexpected admission lifecycle callback')
  }
  const connections = new DaemonClientConnections({
    token: 'test-token',
    protocolVersion: 1,
    identity: {
      launchNonce: null,
      startedAtMs: null,
      entryPath: null,
      appVersion: null,
      spawnerExecPath: null
    },
    log,
    streamDataBatcher: new DaemonStreamDataBatcher(() => undefined),
    isAcceptingWork: () => true,
    onTransportChanged: unexpected,
    onConnectionAccepted: unexpected,
    onAuthenticatedPair: unexpected,
    onLastAuthenticatedClientDisconnected: unexpected,
    onControlRequest: unexpected,
    onControlReplaced: unexpected,
    onClientDisconnected: unexpected,
    onStreamDisconnected: unexpected
  })
  vi.spyOn(connections, 'get').mockReturnValue({
    clientId: 'client',
    authenticatedPairEstablished: true,
    controlSocket: socket,
    streamSocket: socket
  })
  return new DaemonTerminalAdmission({
    host,
    connections,
    endpoint: new DaemonEndpointLifecycle({
      socketPath: 'unused-test-endpoint',
      tokenPath: 'unused-test-token',
      pidPath: null,
      launchNonce: null,
      token: 'test-token',
      publishEndpointOwnership: unexpected,
      log,
      isServing: () => false,
      onOwnershipLost: unexpected
    }),
    preparations: new DaemonPtySpawnPreparations(async () => {}),
    attachments: new DaemonSessionAttachments(host),
    historySeedTransfers: new TerminalHistorySeedTransferRegistry(),
    transientFactRelay: new BackgroundTransientFactRelay(unexpected),
    streamDataBatcher: new DaemonStreamDataBatcher(() => undefined),
    log,
    isAcceptingWork: () => true,
    requestEndpointRetirement: unexpected,
    reevaluateIdleShutdown: vi.fn()
  })
}

describe('daemon terminal admission during teardown', () => {
  it('waits for teardown and creates the respawned pane on its stable id', async () => {
    const spawnSubprocess = vi.fn(slowExitSubprocess)
    const host = new TerminalHost({ spawnSubprocess })
    const socket = new Socket()
    try {
      const admission = admissionFor(host, socket)
      const sessionId = 'wt-1@@respawning-pane'
      const create = (id: string): Promise<unknown> =>
        admission.createOrAttach('client', {
          id,
          type: 'createOrAttach',
          payload: { sessionId, cols: 80, rows: 24 }
        })
      await create('first')

      const killed = host.kill(sessionId, { immediate: true })
      await expect(create('respawn')).resolves.toMatchObject({ isNew: true })

      expect(spawnSubprocess).toHaveBeenCalledTimes(2)
      expect(admission.inFlight).toBe(0)
      await killed
    } finally {
      socket.destroy()
      await host.dispose()
    }
  })
})
