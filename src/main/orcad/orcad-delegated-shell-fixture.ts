import { createServer, type Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { RelayDispatcher } from '../../relay/dispatcher'
import { PtyHandler } from '../../relay/pty-handler'
import { setupDaemonHandshake } from '../../relay/relay-handshake'
import { relayTestSocketPath } from '../../relay/relay-test-socket-path'
import { RelayPtyOwnershipTransferFileStore } from '../../relay/relay-pty-ownership-transfer-file-store'
import { RelayPtyOwnershipTransferAdapter } from '../../relay/relay-pty-ownership-transfer-adapter'
import { connectOrcadLocalRelay } from './orcad-local-relay-connection'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_SUBSCRIBE_METHOD } from '../../shared/pty-ownership-transfer-destination-claim'

export async function createDelegatedShellFixture(
  options: { executionNotifications?: boolean } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-delegated-shell-'))
  const endpoint = relayTestSocketPath(directory)
  const dispatcher = new RelayDispatcher(() => true)
  if (options.executionNotifications === false) {
    const register = dispatcher.onRequest.bind(dispatcher)
    dispatcher.onRequest = (method, handler) =>
      register(
        method,
        method === PTY_OWNERSHIP_TRANSFER_DESTINATION_SUBSCRIBE_METHOD
          ? (params, context) => handler({ ...params, executionNotifications: undefined }, context)
          : handler
      )
  }
  const handler = new PtyHandler(dispatcher, 0)
  let adapter: RelayPtyOwnershipTransferAdapter | undefined
  let transcript = ''
  handler.setOwnershipTransferOutputObserver({
    fencesLegacyAttachment: (id) => adapter?.fencesLegacyAttachment(id) ?? false,
    ownsOutputPublication: (id) => adapter?.ownsOutputPublication(id) ?? false,
    getPreparedOutputByteLimit: (id) => adapter?.getPreparedOutputByteLimit(id),
    observeOutput: (id, data, emission, incarnation) => {
      transcript += data
      return adapter?.observeOutput(id, data, emission, incarnation)
    },
    observeExit: (event) => adapter?.observeExit(event.terminalId, event.incarnationId, event.code),
    removeTerminal: (id) => adapter?.removeTerminal(id)
  })
  const sockets = new Set<Socket>()
  const clients: SshChannelMultiplexer[] = []
  let acceptedConnections = 0
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    setupDaemonHandshake(socket, {
      launchVersion: 'shell-proof',
      endpointCredential: 'shell-proof-secret',
      onAccepted: (connection, leftover) => {
        const clientId = dispatcher.attachClient(
          (bytes, settled) =>
            connection.write(bytes, (error) =>
              settled?.(error ? { ok: false, error } : { ok: true })
            ),
          {
            supportsWriteCallback: true,
            writableHighWaterMark: () => connection.writableHighWaterMark,
            writableLength: () => connection.writableLength,
            close: () => connection.destroy(),
            waitWriteDrain: (listener) => {
              connection.on('drain', listener)
              return () => connection.off('drain', listener)
            }
          },
          {
            principal: 'shell-proof',
            authenticated: true,
            allowSessionOwner: acceptedConnections++ === 0,
            authenticationKind: 'endpoint-credential'
          }
        )
        connection.on('data', (bytes: Buffer) => dispatcher.feedClient(clientId, bytes))
        connection.once('close', () => {
          dispatcher.detachClient(clientId)
          sockets.delete(connection)
        })
        if (leftover.length) {
          dispatcher.feedClient(clientId, leftover)
        }
      }
    })
  })
  const dispose = async () => {
    for (const client of clients) {
      client.dispose()
    }
    await handler.dispose({ waitForPhysicalExit: true })
    dispatcher.dispose()
    for (const socket of sockets) {
      socket.destroy()
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(endpoint, resolve)
    })
    const desktop = await connectOrcadLocalRelay({
      endpoint,
      incumbentVersion: 'shell-proof',
      endpointCredential: 'shell-proof-secret',
      initialize: (client) => clients.push(client)
    })
    const spawned = (await desktop.request('pty.spawn', {
      cwd: directory,
      shellOverride: '/bin/sh',
      cols: 80,
      rows: 24,
      env: { PS1: '', ENV: '/dev/null' }
    })) as { id: string; incarnationId: string }
    const identity = {
      terminalId: spawned.id,
      incarnationId: spawned.incarnationId,
      ownerLease: 'shell-proof-lease',
      sourceOwnerGeneration: 1,
      bridgeId: 'shell-proof-bridge',
      destinationRuntimeId: 'shell-proof-orcad'
    }
    let desktopConnected = true
    adapter = new RelayPtyOwnershipTransferAdapter({
      inspectDestinationProcess: (identity, isAuthorized) =>
        handler.inspectOwnershipTransferProcess(
          identity.terminalId,
          identity.incarnationId,
          isAuthorized
        ),
      inspectDestinationCwd: (identity, isAuthorized) =>
        handler.inspectOwnershipTransferCwd(
          identity.terminalId,
          identity.incarnationId,
          isAuthorized
        ),
      inspectDestinationTerminal: (identity) => {
        const terminal = handler.resolveOwnershipTransferTerminal(identity.terminalId, true)
        return terminal?.incarnationId === identity.incarnationId
          ? terminal.terminalInfo
          : undefined
      },
      store: new RelayPtyOwnershipTransferFileStore(join(directory, 'source')),
      enableDestinationDelegationPreparation: true,
      enableDestinationDelegationClaims: true,
      enableDestinationOutputRetention: true,
      enableDestinationOutputRoutes: true,
      enableDestinationDelegationCommit: true,
      enableDestinationDelegationInput: true,
      enableDestinationDelegationControl: true,
      resolveSource: (id) =>
        desktopConnected && handler.resolveOwnershipTransferTerminal(id) ? identity : null,
      resolveTerminalIncarnation: (id) =>
        handler.resolveOwnershipTransferTerminal(id)?.incarnationId ?? null,
      hasPendingSourceOutput: (id) => handler.hasPendingOwnershipTransferOutput(id),
      setInputFenced: (id, fenced) => handler.setOwnershipTransferInputFenced(id, fenced),
      writeDestinationInput: (id, data) => {
        if (!handler.writeOwnershipTransferInput(id, data)) {
          throw new Error('input rejected')
        }
      },
      applyDestinationControl: (source, control, authorized) =>
        handler.applyOwnershipTransferControl(
          source.terminalId,
          source.incarnationId,
          control,
          authorized
        ),
      publishDestinationOutput: () => {},
      authorizeRequest: () => false
    })
    adapter.register(dispatcher)
    return {
      directory,
      endpoint,
      identity,
      handler,
      adapter,
      clients,
      desktop,
      credential: randomBytes(32).toString('hex'),
      transcript: () => transcript,
      disconnectDesktop: () => {
        desktopConnected = false
        desktop.dispose()
      },
      dispose
    }
  } catch (error) {
    await dispose()
    throw error
  }
}
