import { createServer, type Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { RelayDispatcher } from '../../relay/dispatcher'
import { PtyOwnershipTransferDestinationFileStore } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-file-store'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_CONTROL_METHOD } from '../../shared/pty-ownership-transfer-destination-control'
import {
  PTY_OWNERSHIP_TRANSFER_DESTINATION_INPUT_METHOD,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_RETIRE_INPUT_METHOD
} from '../../shared/pty-ownership-transfer-destination-input'
import { setupDaemonHandshake } from '../../relay/relay-handshake'
import { relayTestSocketPath } from '../../relay/relay-test-socket-path'
import { RelayPtyOwnershipTransferFileStore } from '../../relay/relay-pty-ownership-transfer-file-store'
import {
  makeDelegatedRelay,
  preparation,
  request,
  identity,
  source,
  context
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_SUBSCRIBE_METHOD } from '../../shared/pty-ownership-transfer-destination-claim'
import { PtyOwnershipTransferDestinationOutputOutbox } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-output-outbox'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { connectOrcadDelegatedTransfer } from './orcad-delegated-connection'
import { recoverOrcadDelegatedCommit } from './orcad-delegated-commit-recovery'
import type { installOrcadDelegatedOutputReceiver } from './orcad-delegated-output-receiver'
import { PtyOwnershipTransferDestinationAdapter } from '../../shared/pty-ownership-transfer-destination-adapter'
import { PtyOwnershipTransferDestinationOutputSink } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-output-sink'

it.each([false, true])(
  'delivers and ACKs durable output over an incumbent socket across reconnect (committed=%s)',
  async (committed) => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-output-socket-'))
    const endpoint = relayTestSocketPath(directory)
    const desktopWrite = vi.fn(() => true)
    const destinationWrite = vi.fn()
    const destinationControl = vi.fn(() => 'applied' as const)
    const dispatcher = new RelayDispatcher(desktopWrite)
    const store = new RelayPtyOwnershipTransferFileStore(join(directory, 'source'))
    const outbox = new PtyOwnershipTransferDestinationOutputOutbox({
      directory: join(directory, 'destination')
    })
    outbox.open(identity, 0)
    const destinationStore = new PtyOwnershipTransferDestinationFileStore({
      directory: join(directory, 'catalog')
    })
    destinationStore.prepare(identity, 0)
    destinationStore.bindDelegatedSource(identity, {
      version: 1,
      proof: request(),
      endpoint,
      incumbentVersion: 'incumbent-build',
      endpointCredential: 'endpoint-secret'
    })
    const delivered: string[] = []
    const sink = new PtyOwnershipTransferDestinationOutputSink({
      outbox,
      deliver: (identity, _binding, frame) => {
        delivered.push(frame.data)
        return { identity, throughSeq: frame.seq }
      }
    })
    const destinationAdapter = new PtyOwnershipTransferDestinationAdapter({
      store: destinationStore,
      publishDurably: (request) => request.publicationReceipt,
      publishPostCommitOutput: (identity, binding, frame) => sink.publish(identity, binding, frame),
      markPostCommitOutputBaseline: (identity, seq) => sink.markCommittedThrough(identity, seq)
    })
    destinationAdapter.prepare({
      ...identity,
      version: 1,
      phase: 'prepared',
      sourceOutputEndSeq: 0,
      replayStartSeq: 1,
      surfacePublication: preparation.surfacePublication
    })
    destinationAdapter.bindSurface(preparation.surfacePublication.surfaceBinding)
    let desktopConnected = true
    const adapter = makeDelegatedRelay(store, {
      enableDestinationOutputRetention: true,
      enableDestinationOutputRoutes: true,
      enableDestinationDelegationCommit: committed,
      enableDestinationDelegationInput: committed,
      enableDestinationDelegationControl: committed,
      applyDestinationControl: destinationControl,
      writeDestinationInput: destinationWrite,
      hasPendingSourceOutput: () => false,
      replayBytes: 6,
      resolveSource: () => (desktopConnected ? source : null),
      resolveTerminalIncarnation: () => source.incarnationId
    })
    adapter.register(dispatcher)
    adapter.prepare(preparation)
    desktopConnected = false
    const sockets = new Set<Socket>()
    const clients: SshChannelMultiplexer[] = []
    const receivers: ReturnType<typeof installOrcadDelegatedOutputReceiver>[] = []
    const errors: unknown[] = []
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.on('error', () => {})
      setupDaemonHandshake(socket, {
        launchVersion: 'incumbent-build',
        endpointCredential: 'endpoint-secret',
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
            context().sessionIdentity
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
    const connect = async (generation: number, afterSeq: number) => {
      const controller = new AbortController()
      const connection = await connectOrcadDelegatedTransfer({
        identity,
        store: new PtyOwnershipTransferDestinationFileStore({
          directory: join(directory, 'catalog')
        }),
        adapter: destinationAdapter,
        outbox,
        signal: controller.signal,
        createClaimId: () => `claim-${generation}`,
        onError: (error) => errors.push(error)
      })
      expect(connection.proof).toMatchObject({
        afterSeq,
        destinationClaim: { generation, claimId: `claim-${generation}` }
      })
      clients.push(connection.multiplexer)
      receivers.push(connection.receiver)
      return {
        client: connection.multiplexer,
        proof: connection.proof,
        transfer: connection.client,
        abort: () => controller.abort(),
        isActive: connection.isActive
      }
    }
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(endpoint, resolve)
      })
      adapter.observeOutput(identity.terminalId, 'first')
      const first = await connect(1, 0)
      await vi.waitFor(() => expect(outbox.load(identity)?.acceptedEndSeq).toBe(1))
      await vi.waitFor(() => expect(outbox.load(identity)?.acknowledgedEndSeq).toBe(1))
      const receipt = {
        bridgeId: identity.bridgeId,
        receiptId: 'socket-commit',
        acceptedSourceEndSeq: 1,
        committedAt: '2026-09-06T00:00:00.000Z'
      }
      if (committed) {
        destinationAdapter.commit(receipt)
        await vi.waitFor(async () => {
          await expect(
            recoverOrcadDelegatedCommit({
              identity,
              store: destinationStore,
              client: first.transfer,
              claim: first.proof.destinationClaim
            })
          ).resolves.toMatchObject({ phase: 'committed', receipt })
        })
        await expect(
          first.client.request(PTY_OWNERSHIP_TRANSFER_DESTINATION_INPUT_METHOD, {
            ...first.proof,
            inputId: 'socket-input',
            data: 'echo ready\n'
          })
        ).resolves.toMatchObject({ outcome: 'applied', duplicate: false })
        await expect(
          first.client.request(PTY_OWNERSHIP_TRANSFER_DESTINATION_CONTROL_METHOD, {
            ...first.proof,
            controlId: 'socket-resize',
            control: { kind: 'resize', cols: 100, rows: 30 }
          })
        ).resolves.toMatchObject({ outcome: 'applied', duplicate: false })
      }
      await vi.waitFor(() => adapter.observeOutput(identity.terminalId, 'second'))
      await vi.waitFor(() => expect(outbox.load(identity)?.acceptedEndSeq).toBe(2))
      await vi.waitFor(async () => {
        await first.client.request(PTY_OWNERSHIP_TRANSFER_DESTINATION_SUBSCRIBE_METHOD, {
          ...first.proof,
          afterSeq: 2
        })
      })
      first.abort()
      expect(first.isActive()).toBe(false)
      await expect(first.transfer.status(first.proof)).rejects.toThrow('connection_stale')
      const second = await connect(2, 2)
      if (committed) {
        await expect(
          second.client.request(PTY_OWNERSHIP_TRANSFER_DESTINATION_CONTROL_METHOD, {
            ...second.proof,
            controlId: 'socket-resize',
            control: { kind: 'resize', cols: 100, rows: 30 }
          })
        ).resolves.toMatchObject({ outcome: 'applied', duplicate: true })
        expect(destinationControl).toHaveBeenCalledOnce()
        await expect(
          second.client.request(PTY_OWNERSHIP_TRANSFER_DESTINATION_INPUT_METHOD, {
            ...second.proof,
            inputId: 'socket-input',
            data: 'echo ready\n'
          })
        ).resolves.toMatchObject({ outcome: 'applied', duplicate: true })
        expect(destinationWrite).toHaveBeenCalledExactlyOnceWith(
          identity.terminalId,
          'echo ready\n'
        )
        await expect(
          second.client.request(PTY_OWNERSHIP_TRANSFER_DESTINATION_RETIRE_INPUT_METHOD, {
            ...second.proof,
            inputIds: ['socket-input'],
            inputEpoch: 0
          })
        ).resolves.toMatchObject({ inputEpoch: 1, retired: 1 })
        await expect(
          second.client.request(PTY_OWNERSHIP_TRANSFER_DESTINATION_INPUT_METHOD, {
            ...second.proof,
            inputId: 'socket-input',
            data: 'echo ready\n'
          })
        ).rejects.toThrow('epoch_stale')
        await expect(
          second.client.request(PTY_OWNERSHIP_TRANSFER_DESTINATION_INPUT_METHOD, {
            ...second.proof,
            inputId: 'next-input',
            inputEpoch: 1,
            data: 'echo next\n'
          })
        ).resolves.toMatchObject({ outcome: 'applied', inputEpoch: 1 })
        expect(destinationWrite).toHaveBeenCalledTimes(2)
      }
      adapter.observeOutput(identity.terminalId, 'three')
      await vi.waitFor(() => expect(outbox.load(identity)?.acceptedEndSeq).toBe(3))
      await vi.waitFor(() => expect(outbox.load(identity)?.acknowledgedEndSeq).toBe(3))
      await vi.waitFor(async () => {
        await second.client.request(PTY_OWNERSHIP_TRANSFER_DESTINATION_SUBSCRIBE_METHOD, {
          ...second.proof,
          afterSeq: 3
        })
      })
      expect(outbox.load(identity)?.pendingFrames).toEqual([])
      expect(destinationStore.loadFrames(identity).map((frame) => frame.data)).toEqual(
        committed ? ['first'] : ['first', 'second', 'three']
      )
      expect(delivered).toEqual(committed ? ['second', 'three'] : [])
      expect(
        new PtyOwnershipTransferDestinationOutputOutbox({
          directory: join(directory, 'destination')
        }).load(identity)?.acceptedEndSeq
      ).toBe(3)
      expect(desktopWrite).not.toHaveBeenCalled()
      adapter.observeExit(identity.terminalId, identity.incarnationId, 17)
      await expect(second.transfer.status(second.proof)).resolves.toMatchObject({
        executionVerdict: 'exited',
        sourceOutputEndSeq: 3,
        exit: { code: 17, verdict: 'exited' }
      })
      if (committed) {
        await expect(
          recoverOrcadDelegatedCommit({
            identity,
            store: new PtyOwnershipTransferDestinationFileStore({
              directory: join(directory, 'catalog')
            }),
            client: second.transfer,
            claim: second.proof.destinationClaim
          })
        ).resolves.toMatchObject({ phase: 'committed', receipt })
        expect(store.loadAll()[0]).toMatchObject({ version: 8, commitReceipt: receipt })
      }
      expect(errors).toEqual([])
    } finally {
      for (const receiver of receivers) {
        receiver.dispose()
      }
      for (const client of clients) {
        client.dispose()
      }
      for (const socket of sockets) {
        socket.destroy()
      }
      dispatcher.dispose()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
