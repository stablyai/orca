import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { connectOrcadLocalRelay } from '../main/orcad/orcad-local-relay-connection'
import type { SshChannelMultiplexer } from '../main/ssh/ssh-channel-multiplexer'
import { startLiveRelayDaemon } from './relay-live-daemon-fixture'
import { PTY_OWNERSHIP_CAPTURE_METHODS as capture } from '../shared/pty-ownership-capture-wire'
import { parsePtyOwnershipCaptureBoundary } from '../shared/pty-ownership-capture-boundary'
import { parsePtyOwnershipSourceEndpoint } from '../shared/pty-ownership-source-endpoint'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'

const entry = process.env.ORCA_TEST_RELAY_ENTRY
const bun = process.env.ORCA_TEST_BUN_RUNTIME

it
  .skipIf(!entry || !bun || process.platform === 'win32')
  .each([
    [],
    ['--enable-delegated-ownership-capture'],
    ['--enable-ownership-transfer-mutation'],
    ['--enable-ownership-transfer-mutation', '--enable-delegated-ownership-capture']
  ])(
  'built Bun relay gates native delegated capture with %j',
  async (...flags) => {
    const daemon = await startLiveRelayDaemon(entry!, bun!, flags)
    const { directory, endpoint, incumbentVersion, endpointCredential } = daemon
    let client: SshChannelMultiplexer | undefined
    try {
      let transcript = ''
      client = await connectOrcadLocalRelay({
        endpoint,
        incumbentVersion,
        endpointCredential,
        initialize: (connection) => {
          client = connection
          connection.onNotificationByMethod('pty.data', (output) => {
            transcript += String(output.data)
            connection.notify('pty.ackData', {
              acknowledgements: [
                {
                  id: output.id,
                  clientGeneration: output.clientGeneration,
                  ownerGeneration: output.ownerGeneration,
                  deliveryToken: output.deliveryToken,
                  creditedEndSu: output.sourceEndSu
                }
              ]
            })
          })
        }
      })
      const grant = (await client.request('pty.openClient', {
        protocolVersion: 1,
        clientInstanceId: randomUUID(),
        requestedRole: 'session-owner',
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 1024 } }
      })) as { ownerLease: string; ownerGeneration: number }
      const spawned = (await client.request('pty.spawn', {
        cwd: directory,
        shellOverride: '/bin/sh',
        cols: 80,
        rows: 24,
        env: { PS1: '', ENV: '/dev/null' }
      })) as { id: string; incarnationId: string }
      const identity = {
        terminalId: spawned.id,
        incarnationId: spawned.incarnationId,
        ownerLease: grant.ownerLease,
        sourceOwnerGeneration: grant.ownerGeneration,
        bridgeId: randomUUID(),
        destinationRuntimeId: 'live-proof-orcad'
      }
      client.notify('pty.data', {
        id: spawned.id,
        data: 'stty -echo; printf "\\nNATIVE:%s\\n" "$$"\n'
      })
      await vi.waitFor(() => expect(transcript).toMatch(/NATIVE:\d+/), { timeout: 5000 })
      const request = { version: 1, ...identity, requestId: randomUUID() }
      if (flags.length !== 2) {
        await expect(client.request(capture.begin, request)).rejects.toThrow('Method not found')
        return
      }
      const discovered = parsePtyOwnershipSourceEndpoint(
        await client.request('pty.ownershipTransfer.sourceEndpoint', { version: 1, ...identity }),
        identity
      )
      expect(discovered).toEqual({
        version: 1,
        identity,
        endpoint,
        incumbentVersion,
        endpointCredential
      })
      await expect(
        client.request('pty.ownershipTransfer.sourceEndpoint', {
          version: 1,
          ...identity,
          ownerLease: 'wrong-lease'
        })
      ).rejects.toThrow('unauthorized')
      const prepared = await client.request('pty.ownershipTransfer.prepare', {
        version: 1,
        ...identity,
        destinationDelegation: {
          version: 1,
          credentialSha256: createHash('sha256').update(randomUUID()).digest('hex')
        },
        surfacePublication: {
          version: 1,
          surfaceBinding: {
            executionHostId: 'local',
            workspaceKey: 'folder:live-proof',
            tabId: 'live-proof',
            leafId: randomUUID(),
            ptyId: spawned.id
          }
        }
      })
      expect(prepared).toMatchObject({ destinationDelegation: { version: 1 } })
      const store = new RelayPtyOwnershipTransferFileStore(
        join(directory, 'hooks', 'pty-ownership-transfer')
      )
      expect(store.loadAll()).toMatchObject([{ identity }])
      const token = (await client.request(capture.begin, request)) as Record<string, unknown>
      try {
        await vi.waitFor(
          async () => {
            const inspected = (await client!.request(capture.inspect, token)) as {
              boundary: unknown
            }
            expect(parsePtyOwnershipCaptureBoundary(inspected.boundary, identity)).toMatchObject({
              identity
            })
          },
          { timeout: 3000 }
        )
      } finally {
        await client.request(capture.release, token)
      }
    } finally {
      client?.dispose()
      await daemon.dispose()
    }
  },
  40_000
)
