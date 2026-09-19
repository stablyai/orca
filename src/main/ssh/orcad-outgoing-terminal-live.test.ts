import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { startLiveRelayDaemon } from '../../relay/relay-live-daemon-fixture'
import { connectOrcadLocalRelay } from '../orcad/orcad-local-relay-connection'
import { OrcadDelegatedTransferClient } from '../orcad/orcad-delegated-transfer-client'
import { createStore, testState } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { OrcadRuntimeLifetime } from '../orcad/orcad-runtime-lifetime'
import { installOrcadDelegatedRecovery } from '../orcad/orcad-delegated-recovery-lifecycle'
import { createOrcadDelegatedProviderBinding } from '../orcad/orcad-delegated-pty-provider'
import { installLiveSourceModel } from './orcad-live-source-model-fixture'
import { prepareOutgoingOrcadTerminalFromProvider } from './orcad-outgoing-terminal-preparation'
import {
  listOutgoingOrcadRecoveryCandidates,
  recoverSelectedOutgoingOrcadCapture
} from './orcad-outgoing-recovery-selection'
import { PTY_OWNERSHIP_TRANSFER_METHODS } from '../../shared/pty-ownership-transfer-wire'
import { PTY_OWNERSHIP_CAPTURE_METHODS } from '../../shared/pty-ownership-capture-wire'
import { OrcadOutgoingCaptureStore } from './orcad-outgoing-capture-store'
import { OrcadOutgoingPreparationStore } from './orcad-outgoing-preparation-store'
import { SshConnectionStore } from './ssh-connection-store'
import { getSshTargetRegistryStore, setSshTargetRegistryStore } from './ssh-target-registry'
import {
  addEnvironmentFromPairingCode,
  markEnvironmentUsed
} from '../../shared/runtime-environment-store'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../../shared/pty-ownership-transfer-release-gate'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const entry = process.env.ORCA_TEST_RELAY_ENTRY
const bun = process.env.ORCA_TEST_BUN_RUNTIME

it
  .skipIf(!entry || !bun || process.platform === 'win32')
  .each(['none', 'publication', 'preparation', 'selection'] as const)(
  'captures the actual SSH provider model and publishes through the outgoing coordinator (lost reply=%s)',
  async (loseReply) => {
    const daemon = await startLiveRelayDaemon(entry!, bun!, [
      '--enable-ownership-transfer-mutation',
      '--enable-delegated-ownership-capture'
    ])
    const previousTargets = getSshTargetRegistryStore()
    const lifetime = new OrcadRuntimeLifetime(() => {})
    let source: ReturnType<typeof installLiveSourceModel> | undefined
    let mux: Awaited<ReturnType<typeof connectOrcadLocalRelay>> | undefined
    let server: OrcaRuntimeRpcServer | undefined
    vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '1')
    try {
      testState.dir = join(daemon.directory, 'destination')
      mkdirSync(testState.dir)
      const destinationStore = createStore()
      const runtimeId = randomUUID()
      const destination = new OrcaRuntimeService(destinationStore, undefined, {
        runtimeId,
        ptyOwnershipTransferMutationEnabled: () => true
      })
      destination.installPtyOwnershipTransferDestinationOutputBridge()
      const registry = destination.getPtyOwnershipTransferDestinationRegistry()!
      const errors: unknown[] = []
      const lifecycle = installOrcadDelegatedRecovery({
        enabled: true,
        lifetime,
        registry,
        onError: (_identity, error) => {
          errors.push(error)
        },
        onExit: (event) => destination.acceptDelegatedPtyExit(event),
        recoverRetirement: destination.recoverDelegatedPtyRetirement,
        onExecutionState: (identity, claim) =>
          destination.acceptDelegatedPtyExecutionState(identity, claim),
        bindConnection: createOrcadDelegatedProviderBinding(destination, () => ({
          getDefaultShell: async () => '/bin/sh',
          getProfiles: async () => []
        })),
        initializeModel: async (identity, signal) => {
          destination.registerPublishedDelegatedPty(identity)
          await destination.initializeDelegatedPtyOwnershipModel(identity, signal)
        },
        providerModel: {
          snapshot: (identity, options) =>
            destination.serializePublishedDelegatedPtyModel(identity, options),
          sequence: (identity) => destination.getPtyOutputSequence(identity.terminalId)
        },
        prepareModelFrame: (identity, frame, signal) =>
          destination.prepareDelegatedPtyModelFrame(identity, frame, signal)
      })!
      lifetime.add(destination.installCapturedPtyDestinationLifecycle(lifecycle))
      server = new OrcaRuntimeRpcServer({
        runtime: destination,
        userDataPath: testState.dir,
        enableWebSocket: true,
        pinnedBindHost: '127.0.0.1',
        wsPort: 0
      })
      await server.start()
      const offer = server.createPairingOffer({
        address: '127.0.0.1',
        name: 'live-capture',
        scope: 'runtime'
      })
      if (!offer.available) {
        throw new Error('pairing unavailable')
      }
      testState.dir = join(daemon.directory, 'desktop')
      mkdirSync(testState.dir)
      const desktopStore = createStore()
      const desktop = new OrcaRuntimeService(desktopStore, undefined, { runtimeId: 'desktop' })
      const targetId = randomUUID()
      desktopStore.addSshTarget({
        id: targetId,
        label: 'Private fixture',
        host: 'localhost',
        port: 22,
        username: 'fixture',
        generation: 1
      })
      setSshTargetRegistryStore(new SshConnectionStore(desktopStore))
      addEnvironmentFromPairingCode(testState.dir, {
        id: 'destination',
        name: 'Destination',
        pairingCode: offer.pairingUrl
      })
      markEnvironmentUsed(testState.dir, 'destination', { runtimeId })
      mux = await connectOrcadLocalRelay({ ...daemon, initialize: () => {} })
      const grant = (await mux.request('pty.openClient', {
        protocolVersion: 1,
        clientInstanceId: randomUUID(),
        requestedRole: 'session-owner',
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 1024 } }
      })) as { ownerLease: string; ownerGeneration: number }
      source = installLiveSourceModel(desktop, mux, targetId, grant)
      const spawned = await source.provider.spawn({
        cwd: daemon.directory,
        shellOverride: '/bin/sh',
        cols: 80,
        rows: 24,
        env: { PS1: '', ENV: '/dev/null' }
      })
      const surfaceBinding = {
        executionHostId: 'local',
        workspaceKey: 'folder:live',
        tabId: 'live',
        leafId: randomUUID(),
        ptyId: source.provider.getOwnershipTransferSourceIdentity(spawned.id)!.terminalId
      }
      desktop.registerPty(spawned.id, 'folder:live', targetId, {
        tabId: surfaceBinding.tabId,
        leafId: surfaceBinding.leafId,
        incarnationId: spawned.incarnationId
      })
      source.ready()
      source.provider.write(
        spawned.id,
        `stty -echo; ORCA_CAPTURE_VALUE=retained; printf "\\nCAPTURE:%s:%s\\n" "$$" "$ORCA_CAPTURE_VALUE"${
          loseReply === 'selection'
            ? '; while [ ! -f continue-capture ]; do sleep 0.05; done; printf "\\nAFTER_CAPTURE:%s:%s\\n" "$$" "$ORCA_CAPTURE_VALUE"\n'
            : '\n'
        }`
      )
      await vi.waitFor(
        async () => {
          await source!.drain()
          expect(source!.errors).toEqual([])
          const model = await desktop.serializeMainTerminalBuffer(spawned.id)
          expect(model?.data).toMatch(/CAPTURE:\d+:retained/)
        },
        { timeout: 5000 }
      )
      const args = {
        selector: 'destination',
        ptyId: spawned.id,
        surfaceBinding,
        signal: new AbortController().signal,
        runtime: desktop
      }
      if (loseReply === 'selection') {
        const request = source.provider.requestHostRpc.bind(source.provider)
        const intercept = vi.spyOn(source.provider, 'requestHostRpc')
        intercept.mockImplementation(async (method, params, options) => {
          if (method === PTY_OWNERSHIP_CAPTURE_METHODS.select) {
            throw new Error('source selection request interrupted')
          }
          return request(method, params, options)
        })
        try {
          await expect(
            prepareOutgoingOrcadTerminalFromProvider(testState.dir, args)
          ).rejects.toThrow('source selection request interrupted')
        } finally {
          intercept.mockRestore()
        }
        const saved = new OrcadOutgoingCaptureStore(testState.dir).list()
        expect(saved).toHaveLength(1)
        expect(registry.get(saved[0].identity.bridgeId)).toBeNull()
        expect(saved[0].model.modelData).not.toMatch(/AFTER_CAPTURE:\d+:retained/)
        writeFileSync(join(daemon.directory, 'continue-capture'), '')
        await vi.waitFor(
          async () => {
            await source!.drain()
            expect((await desktop.serializeMainTerminalBuffer(spawned.id))?.data).toMatch(
              /AFTER_CAPTURE:\d+:retained/
            )
          },
          { timeout: 5000 }
        )
        mux.dispose()
        const recover = OrcadDelegatedTransferClient.prototype.recoverCaptureSelection
        const lostRecoveryReply = vi.spyOn(
          OrcadDelegatedTransferClient.prototype,
          'recoverCaptureSelection'
        )
        lostRecoveryReply.mockImplementationOnce(
          async function (this: OrcadDelegatedTransferClient, proof, baseline, options) {
            await recover.call(this, proof, baseline, options)
            throw new Error('recovery selection reply interrupted')
          }
        )
        try {
          await expect(
            recoverSelectedOutgoingOrcadCapture(testState.dir, {
              selector: 'destination',
              bridgeId: saved[0].identity.bridgeId,
              signal: args.signal
            })
          ).rejects.toThrow('orcad_captured_destination_failed:')
          expect(lostRecoveryReply).toHaveBeenCalledOnce()
          expect(registry.get(saved[0].identity.bridgeId)).toBeNull()
          expect(new OrcadOutgoingCaptureStore(testState.dir).list()).toEqual(saved)
        } finally {
          lostRecoveryReply.mockRestore()
        }
        await recoverSelectedOutgoingOrcadCapture(testState.dir, {
          selector: 'destination',
          bridgeId: saved[0].identity.bridgeId,
          signal: args.signal
        })
        expect(new OrcadOutgoingCaptureStore(testState.dir).list()).toEqual(saved)
      } else if (loseReply === 'preparation') {
        const request = source.provider.requestHostRpc.bind(source.provider)
        const intercept = vi.spyOn(source.provider, 'requestHostRpc')
        let interrupted = false
        intercept.mockImplementation(async (method, params, options) => {
          const result = await request(method, params, options)
          if (method === PTY_OWNERSHIP_TRANSFER_METHODS.prepare && !interrupted) {
            interrupted = true
            throw new Error('source preparation response interrupted')
          }
          return result
        })
        try {
          await expect(
            prepareOutgoingOrcadTerminalFromProvider(testState.dir, args)
          ).rejects.toThrow('source preparation response interrupted')
        } finally {
          intercept.mockRestore()
        }
        expect(new OrcadOutgoingCaptureStore(testState.dir).list()).toEqual([])
        const intents = new OrcadOutgoingPreparationStore(testState.dir).list()
        expect(intents).toHaveLength(1)
        const candidates = listOutgoingOrcadRecoveryCandidates(testState.dir, 'destination', true)
        expect(candidates).toHaveLength(1)
        expect(candidates[0].stage).toBe('preparation')
        await recoverSelectedOutgoingOrcadCapture(testState.dir, {
          selector: 'destination',
          bridgeId: candidates[0].bridgeId,
          stage: candidates[0].stage,
          runtime: desktop,
          signal: args.signal
        })
        expect(new OrcadOutgoingPreparationStore(testState.dir).list()).toEqual(intents)
        const after = listOutgoingOrcadRecoveryCandidates(testState.dir, 'destination', true)
        expect(after).toHaveLength(1)
        expect(after[0].stage).toBeUndefined()
      } else if (loseReply === 'publication') {
        const interrupted = new AbortController()
        const prepare = destination.prepareCapturedPtyDestination.bind(destination)
        const intercept = vi.spyOn(destination, 'prepareCapturedPtyDestination')
        intercept.mockImplementationOnce(async (request) => {
          const result = await prepare(request)
          interrupted.abort(new Error('publication response interrupted'))
          return result
        })
        try {
          await expect(
            prepareOutgoingOrcadTerminalFromProvider(testState.dir, {
              ...args,
              signal: interrupted.signal
            })
          ).rejects.toThrow()
        } finally {
          intercept.mockRestore()
        }
      } else {
        await prepareOutgoingOrcadTerminalFromProvider(testState.dir, args)
      }
      const captures = new OrcadOutgoingCaptureStore(testState.dir).list()
      expect(captures).toHaveLength(1)
      const saved = captures[0]
      expect(saved.model.modelData).toMatch(/CAPTURE:\d+:retained/)
      expect(new OrcadOutgoingPreparationStore(testState.dir).read(saved.identity)).not.toBeNull()
      expect(registry.get(saved.identity.bridgeId)?.snapshot().phase).toBe('published')
      await recoverSelectedOutgoingOrcadCapture(testState.dir, {
        selector: 'destination',
        bridgeId: saved.identity.bridgeId,
        signal: args.signal
      })
      expect(new OrcadOutgoingCaptureStore(testState.dir).list()).toEqual(captures)
      expect(source.errors).toEqual([])
      const pid = saved.model.modelData.match(/CAPTURE:(\d+):retained/)![1]
      await vi.waitFor(
        () => {
          expect(lifecycle.supervisor.getConnection(saved.identity)?.isCommitReconciled()).toBe(
            true
          )
        },
        { timeout: 5000 }
      )
      source.dispose()
      source = undefined
      mux.dispose()
      const first = lifecycle.supervisor.getConnection(saved.identity)!
      await expect(
        first.providerInput.writeWithSettlement(
          saved.identity.terminalId,
          'printf "\\nDESTINATION:%s:%s\\n" "$$" "$ORCA_CAPTURE_VALUE"\n',
          { operationId: randomUUID() }
        )
      ).resolves.toBe(true)
      await vi.waitFor(
        async () => {
          const model = await destination.serializePublishedDelegatedPtyModel(saved.identity)
          expect(model?.data).toContain(`DESTINATION:${pid}:retained`)
        },
        { timeout: 5000 }
      )
      first.dispose()
      await vi.waitFor(
        () => {
          const next = lifecycle.supervisor.getConnection(saved.identity)
          expect(next).not.toBe(first)
          expect(next?.isCommitReconciled()).toBe(true)
        },
        { timeout: 5000 }
      )
      const reconnected = lifecycle.supervisor.getConnection(saved.identity)!
      await expect(
        reconnected.providerInput.writeWithSettlement(
          saved.identity.terminalId,
          'printf "\\nRECONNECTED:%s:%s\\n" "$$" "$ORCA_CAPTURE_VALUE"\n',
          { operationId: randomUUID() }
        )
      ).resolves.toBe(true)
      await vi.waitFor(
        async () => {
          const model = await destination.serializePublishedDelegatedPtyModel(saved.identity)
          expect(model?.data).toContain(`RECONNECTED:${pid}:retained`)
          expect(model?.data.match(/(?:^|\n)CAPTURE:\d+:retained/g)).toHaveLength(1)
          expect(model?.data.match(/DESTINATION:\d+:retained/g)).toHaveLength(1)
          if (loseReply === 'selection') {
            expect(
              model?.data.match(new RegExp(`AFTER_CAPTURE:${pid}:retained`, 'g'))
            ).toHaveLength(1)
          }
        },
        { timeout: 5000 }
      )
      expect(errors).toEqual([])
    } finally {
      await server?.stop()
      await lifetime.stop()
      source?.dispose()
      mux?.dispose()
      setSshTargetRegistryStore(previousTargets)
      vi.unstubAllEnvs()
      await daemon.dispose()
    }
  },
  40_000
)
