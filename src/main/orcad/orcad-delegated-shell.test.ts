import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createDelegatedShellFixture } from './orcad-delegated-shell-fixture'
import { connectOrcadDelegatedTransfer } from './orcad-delegated-connection'
import { OrcadDelegatedConnectionSupervisor } from './orcad-delegated-connection-supervisor'
import { PtyOwnershipTransferDestinationAdapter } from '../../shared/pty-ownership-transfer-destination-adapter'
import { PtyOwnershipTransferDestinationFileStore } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-file-store'
import { PtyOwnershipTransferDestinationOutputOutbox } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-output-outbox'
import { PtyOwnershipTransferDestinationOutputSink } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-output-sink'

it.skipIf(process.platform === 'win32').each(['direct', 'supervised', 'legacy-status'] as const)(
  'POSIX native shell keeps PID, variable, input, resize and exit across %s delegated commit/reconnect',
  async (mode) => {
    const fixture = await createDelegatedShellFixture({
      executionNotifications: mode !== 'legacy-status'
    })
    const controllers: AbortController[] = []
    let supervisor: OrcadDelegatedConnectionSupervisor | undefined
    try {
      const { identity } = fixture
      fixture.desktop.notify('pty.data', {
        id: identity.terminalId,
        data: 'stty -echo; ORCA_PROOF_VALUE=retained; printf \'\\nINITIAL:%s:%s\\n\' "$$" "$ORCA_PROOF_VALUE"\n'
      })
      await vi.waitFor(() => expect(fixture.transcript()).toMatch(/INITIAL:\d+:retained/), {
        timeout: 5000
      })
      const pid = fixture.transcript().match(/INITIAL:(\d+):retained/)![1]
      expect(Number(pid)).toBeGreaterThan(0)
      fixture.desktop.notify('pty.data', {
        id: identity.terminalId,
        data: 'cd /; printf "\\nCWD_READY\\n"\n'
      })
      await vi.waitFor(() => expect(fixture.transcript()).toContain('CWD_READY'), {
        timeout: 5000
      })
      expect(
        fixture.handler.resolveOwnershipTransferTerminal(identity.terminalId, true)?.terminalInfo
          ?.initialCwd
      ).toBe(fixture.directory)
      await expect(
        fixture.handler.inspectOwnershipTransferCwd(
          identity.terminalId,
          identity.incarnationId,
          () => true
        )
      ).resolves.toBe('/')
      const surfaceBinding = {
        executionHostId: 'local' as const,
        workspaceKey: 'folder:proof' as const,
        tabId: 'shell-proof',
        leafId: '11111111-1111-4111-8111-111111111111',
        ptyId: identity.terminalId
      }
      const prepared = fixture.adapter.prepare({
        ...identity,
        version: 1,
        destinationDelegation: {
          version: 1,
          credentialSha256: createHash('sha256').update(fixture.credential).digest('hex')
        },
        surfacePublication: { version: 1, surfaceBinding }
      })
      const store = new PtyOwnershipTransferDestinationFileStore({
        directory: join(fixture.directory, 'destination')
      })
      const outbox = new PtyOwnershipTransferDestinationOutputOutbox({
        directory: join(fixture.directory, 'outbox')
      })
      outbox.open(identity, prepared.replayStartSeq - 1)
      const delivered: string[] = []
      const sink = new PtyOwnershipTransferDestinationOutputSink({
        outbox,
        deliver: (identity, _binding, frame) => {
          delivered.push(frame.data)
          return { identity, throughSeq: frame.seq }
        }
      })
      const destination = new PtyOwnershipTransferDestinationAdapter({
        store,
        publishDurably: (request) => request.publicationReceipt,
        publishPostCommitOutput: (identity, binding, frame) =>
          sink.publish(identity, binding, frame),
        markPostCommitOutputBaseline: (identity, seq) => sink.markCommittedThrough(identity, seq)
      })
      destination.prepare(prepared)
      destination.bindSurface(surfaceBinding)
      store.bindDelegatedSource(identity, {
        version: 1,
        proof: { ...identity, version: 1, credential: fixture.credential },
        endpoint: fixture.endpoint,
        incumbentVersion: 'shell-proof',
        endpointCredential: 'shell-proof-secret'
      })
      const errors: unknown[] = []
      const onExit = vi.fn(() => {
        expect(delivered.join('')).toContain('SIZE_DONE')
        expect(outbox.load(identity)?.pendingFrames).toEqual([])
      })
      if (mode === 'supervised') {
        const controller = new AbortController()
        controllers.push(controller)
        supervisor = new OrcadDelegatedConnectionSupervisor({
          signal: controller.signal,
          onError: (_identity, error) => errors.push(error)
        })
      }
      const connect = async () => {
        if (supervisor) {
          supervisor.track({ identity, store, outbox, adapter: destination, onExit })
          await vi.waitFor(() => expect(supervisor!.getConnection(identity)).not.toBeNull(), {
            timeout: 5000
          })
          const connection = supervisor.getConnection(identity)!
          fixture.clients.push(connection.multiplexer)
          return connection
        }
        const controller = new AbortController()
        controllers.push(controller)
        const connection = await connectOrcadDelegatedTransfer({
          onExit,
          identity,
          store,
          outbox,
          adapter: destination,
          signal: controller.signal,
          onError: (error) => errors.push(error)
        })
        fixture.clients.push(connection.multiplexer)
        return connection
      }
      fixture.disconnectDesktop()
      const first = await connect()
      await expect(
        first.multiplexer.request('pty.attach', { id: identity.terminalId })
      ).rejects.toThrow('legacy_attachment_fenced')
      await vi.waitFor(
        () => {
          const output = outbox.load(identity)!
          expect(output.acknowledgedEndSeq).toBeGreaterThanOrEqual(prepared.sourceOutputEndSeq)
          expect(output.pendingFrames).toEqual([])
        },
        { timeout: 5000 }
      )
      const receipt = {
        bridgeId: identity.bridgeId,
        receiptId: 'native-shell-receipt',
        acceptedSourceEndSeq: destination.snapshot().acceptedSourceEndSeq,
        committedAt: new Date().toISOString()
      }
      destination.commit(receipt)
      destination.publish()
      first.retryCommit()
      await vi.waitFor(() => expect(first.isCommitReconciled()).toBe(true), { timeout: 5000 })
      await expect(first.client.status(first.proof)).resolves.toMatchObject({
        phase: 'committed',
        receipt
      })
      await expect(
        first.providerInput.writeWithSettlement(
          identity.terminalId,
          'printf \'\\nCOMMITTED:%s:%s\\n\' "$$" "$ORCA_PROOF_VALUE"\n',
          { operationId: 'after-commit' }
        )
      ).resolves.toBe(true)
      await vi.waitFor(() => expect(delivered.join('')).toContain(`COMMITTED:${pid}:retained`), {
        timeout: 5000
      })
      await first.operations.settleInput(identity.terminalId, 'after-commit', 0)
      const retire = first.client.retireInput.bind(first.client)
      vi.spyOn(first.client, 'retireInput').mockImplementationOnce(async (...args) => {
        await retire(...args)
        throw new Error('retirement reply lost')
      })
      await expect(
        first.operations.retireInput(identity.terminalId, ['after-commit'], 0)
      ).rejects.toThrow('retirement reply lost')
      first.dispose()
      expect(first.isActive()).toBe(false)
      const second = await connect()
      await vi.waitFor(() => expect(second.isCommitReconciled()).toBe(true), { timeout: 5000 })
      await expect(second.client.status(second.proof)).resolves.toMatchObject({ inputEpoch: 1 })
      await expect(second.operations.recoverInputRetirement(identity.terminalId)).resolves.toEqual({
        epoch: 1,
        retiring: false,
        entries: []
      })
      await expect(
        second.operations.input(identity.terminalId, 'after-commit', 'must not run', 0)
      ).rejects.toThrow('input_epoch_conflict')
      const legacyExits: unknown[] = []
      second.multiplexer.onNotificationByMethod('pty.exit', (event) => legacyExits.push(event))
      await expect(
        second.multiplexer.request('pty.attach', { id: identity.terminalId })
      ).rejects.toThrow('legacy_attachment_fenced')
      expect(second.proof.destinationClaim.generation).toBe(
        first.proof.destinationClaim.generation + 1
      )
      second.providerControls.resize(identity.terminalId, 103, 37, { operationId: 'real-resize' })
      await second.providerInput.whenIdle()
      await expect(
        second.operations.inspectTerminalInfo(identity.terminalId)
      ).resolves.toMatchObject({ pid: Number(pid), cols: 103, rows: 37 })
      await expect(second.providerInspection.getCwd(identity.terminalId)).resolves.toBe('/')
      await expect(
        second.providerInspection.inspectProcess(identity.terminalId)
      ).resolves.toMatchObject({
        foregroundProcessEvidence: {
          verdict: 'live',
          ptyId: identity.terminalId,
          ptyIncarnationId: identity.incarnationId
        }
      })
      await expect(second.providerInspection.getInitialCwd(identity.terminalId)).resolves.toBe(
        fixture.directory
      )
      await expect(second.providerInspection.getAppliedSize(identity.terminalId)).resolves.toEqual({
        cols: 103,
        rows: 37
      })
      await expect(
        second.providerInput.writeWithSettlement(
          identity.terminalId,
          'printf \'\\nRECONNECTED:%s:%s\\n\' "$$" "$ORCA_PROOF_VALUE"; stty size; printf \'SIZE_DONE\\n\'\n',
          { operationId: 'after-reconnect' }
        )
      ).resolves.toBe(true)
      await vi.waitFor(
        () => {
          expect(delivered.join('')).toContain(`RECONNECTED:${pid}:retained`)
          expect(delivered.join('')).toMatch(/37 103\r?\nSIZE_DONE/)
        },
        { timeout: 5000 }
      )
      await second.operations.input(identity.terminalId, 'natural-exit', 'exit 17\n', 1)
      await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1), { timeout: 5000 })
      await vi.waitFor(
        async () => {
          const status = await second.client.status(second.proof)
          expect(status).toMatchObject({
            executionVerdict: 'exited',
            exit: { code: 17, verdict: 'exited' }
          })
          expect(outbox.load(identity)?.acknowledgedEndSeq).toBe(status.sourceOutputEndSeq)
          await expect(second.refreshExecution()).resolves.toMatchObject({
            executionVerdict: 'exited',
            exit: { code: 17, verdict: 'exited' }
          })
        },
        { timeout: 5000 }
      )
      expect(errors).toEqual([])
      expect(legacyExits).toEqual([])
      await second.refreshExecution()
      expect(onExit).toHaveBeenCalledTimes(1)
      expect(onExit.mock.calls[0]).toMatchObject([{ exit: { code: 17 } }])
    } finally {
      for (const controller of controllers) {
        controller.abort()
      }
      await supervisor?.stop()
      await fixture.dispose()
    }
  },
  20_000
)
