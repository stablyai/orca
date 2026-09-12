import { createServer, type Socket } from 'node:net'
import { vi } from 'vitest'
import { createOrcadModelImportFixture } from './orcad-model-import-test-fixture'
import { relayTestSocketPath } from '../../relay/relay-test-socket-path'
import { setupDaemonHandshake } from '../../relay/relay-handshake'
import { RelayDispatcher } from '../../relay/dispatcher'
import {
  makeDelegatedRelay,
  identity
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import type { RelayPtyOwnershipTransferAdapterOptions } from '../../relay/relay-pty-ownership-transfer-adapter'

export async function createOrcadModelImportSocketFixture(
  directory: string,
  options: {
    endpointCredential?: string
    laterOutput?: string
    sourceOptions?: Partial<RelayPtyOwnershipTransferAdapterOptions>
  } = {}
) {
  const endpoint = relayTestSocketPath(directory)
  const fixture = createOrcadModelImportFixture(directory, endpoint)
  const restoreSource = () =>
    makeDelegatedRelay(fixture.sourceStore, {
      enableDestinationOutputRetention: true,
      enableCaptureImportAcknowledgement: true,
      ...options.sourceOptions
    })
  let source = restoreSource()
  source.observeOutput(identity.terminalId, options.laterOutput ?? 'after restart')
  const accepted = vi.fn<() => void>()
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    setupDaemonHandshake(socket, {
      launchVersion: 'registered-build',
      endpointCredential: options.endpointCredential ?? 'registered-credential',
      onAccepted: (connection, leftover) => {
        accepted()
        const dispatcher = new RelayDispatcher(
          (data, onSettled) =>
            connection.write(data, (error) =>
              onSettled(error ? { ok: false, error } : { ok: true })
            ),
          { supportsWriteCallback: true },
          {
            principal: 'host-local',
            authenticated: true,
            allowSessionOwner: false,
            authenticationKind: 'endpoint-credential'
          }
        )
        source.register(dispatcher)
        socket.once('close', () => dispatcher.dispose())
        socket.on('data', (data: Buffer) => dispatcher.feed(data))
        if (leftover.length) {
          dispatcher.feed(leftover)
        }
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint, resolve)
  })
  const close = async () => {
    for (const socket of sockets) {
      socket.destroy()
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  const reopenSource = async () => {
    await Promise.all(
      [...sockets].map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.once('close', resolve)
            socket.destroy()
          })
      )
    )
    source = restoreSource()
  }
  return {
    ...fixture,
    get source() {
      return source
    },
    accepted,
    close,
    reopenSource
  }
}
