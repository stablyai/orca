import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as StructuredRegistry from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { ResolvedBotWorkTargetPlacement } from '../../shared/agent-session/work-target/agent-session-work-target'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORK_TARGET_FOLLOW_UP_RUNTIME_CAPABILITY
} from '../../shared/orchestration/orchestration-runtime-capabilities'
import { E2EE_V2_TOKEN_CAPABILITIES_RUNTIME_CAPABILITY } from '../../shared/remote-runtime/pairing/device-key-capability'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRpcResponse
} from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { sendEnvelopedOneShotCall } from '../ipc/runtime-environments/requests/runtime-environment-runtime-pinned-send'
import { E2EEChannel } from '../runtime/rpc/mobile/e2ee/e2ee-channel'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { readMessageWorkTargetProvenance } from '../runtime/orchestration/db/messages/message-work-target-provenance'
import { adoptRemoteAttempt } from '../runtime/orchestration/db/remote-owned/remote-placements'
import { openRemoteRunLink } from '../runtime/orchestration/db/remote-owned/remote-run-links'
import type {
  OrchestrationEnvironmentSendOptions,
  OrchestrationEnvironmentTransport
} from '../runtime/orchestration/federation/environment-transport'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import type { RpcRequest } from '../runtime/rpc/core'
import { ORCHESTRATION_METHODS } from '../runtime/rpc/methods/orchestration/orchestration'
import {
  BOT_ADDRESS,
  BOT_SESSION_ID,
  createFollowUpHostFixture,
  expectRpcFailure,
  installStructuredSessionHost,
  nextRequestId,
  rpcReq,
  seedLocalWorker,
  teardownFollowUpTestFixtures
} from './bot-work-target-follow-up.test-fixture'

const structuredHostRef: { current: unknown } = { current: null }

vi.mock(
  '../native-chat/agent-session-wire/host/structured-agent-session-registry',
  async (importOriginal) => {
    const actual = await importOriginal<typeof StructuredRegistry>()
    return { ...actual, getStructuredAgentSessionHost: () => structuredHostRef.current }
  }
)

const tempDirs: string[] = []
const dbs: OrchestrationDb[] = []

afterEach(() => teardownFollowUpTestFixtures(structuredHostRef, dbs, tempDirs))

type TransportCallLog = {
  method: string
  expectedRuntimeId?: string
  expectedPairingRevision?: number
  forceStatusProbe?: true
  hadPeerWorkTarget: boolean
  deliveredToRuntimeId?: string
}

function makePairedTarget(args: {
  pairingRevision: number
  peerFingerprint: string
}): ResolvedBotWorkTargetPlacement {
  return {
    mode: 'existing',
    worktreeSelector: 'identity:wt2:local:inst-acme-1',
    onEnvironmentId: 'env-build',
    onExpectedPairingRevision: args.pairingRevision,
    onExpectedPeerFingerprint: args.peerFingerprint,
    expectedWorkspaceInstanceId: 'inst-acme-1',
    canonicalTarget: {
      kind: 'workspace',
      hostId: 'runtime:env-build',
      projectId: 'proj-acme',
      repoId: 'repo-acme',
      repoKind: 'git',
      workspaceId: 'wt-acme',
      workspaceInstanceId: 'inst-acme-1',
      workspaceKind: 'git-worktree',
      displayName: 'feat/auth-fix',
      projectName: 'acme-api',
      hostLabel: 'Build Server',
      pairingRevision: args.pairingRevision,
      peerFingerprint: args.peerFingerprint
    }
  }
}

describe('runtime-instance-pinned paired remote-owned follow-ups', () => {
  it('pins targeted follow-ups to the verified server runtime instance, blocks rollback to an older build on the same pairing, retries once onto a restarted capable runtime, and keeps untargeted calls working', async () => {
    const serverDir = mkdtempSync(join(tmpdir(), 'orca-runtime-pin-server-'))
    tempDirs.push(serverDir)
    const serverDbFile = join(serverDir, 'server-orchestration.db')

    const serverV1 = await createFollowUpHostFixture({
      hostRef: structuredHostRef,
      tempDirs,
      dbs,
      dbFile: serverDbFile,
      tag: 'server-v1'
    })

    const pairingRevision = 11
    const peerFingerprint = 'fp-server-pinned-v11'
    let activeServer: {
      runtimeId: string
      capabilities: string[]
      dispatcher: RpcDispatcher
      stripPeerWorkTarget: boolean
      statusError?: Error
    } = {
      runtimeId: serverV1.runtime.getRuntimeId(),
      capabilities: [
        ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
        ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY,
        ORCHESTRATION_WORK_TARGET_FOLLOW_UP_RUNTIME_CAPABILITY
      ],
      dispatcher: serverV1.dispatcher,
      stripPeerWorkTarget: false
    }

    const transportCalls: TransportCallLog[] = []
    let livePairingRevision = pairingRevision
    let livePeerFingerprint = peerFingerprint
    let onNextSend: (() => void) | null = null

    // Real OrchestrationEnvironmentTransport boundary enforcing expectedPairingRevision + same-connection expectedRuntimeId.
    const transport: OrchestrationEnvironmentTransport = {
      resolve: async (selector) => {
        if (selector !== 'env-build' && selector !== 'Build Server') {
          throw new Error(`Unknown server: ${selector}`)
        }
        return {
          environmentId: 'env-build',
          name: 'Build Server',
          pairingRevision: livePairingRevision,
          peerFingerprint: livePeerFingerprint,
          homePeerFingerprint: 'fp-home-1'
        }
      },
      call: async (
        _selector: string,
        method: string,
        params: unknown,
        _timeoutMs?: number,
        envelope?: RuntimeOrchestrationEnvelope,
        expectedEnvironmentPairingRevision?: number,
        send?: OrchestrationEnvironmentSendOptions
      ): Promise<RuntimeRpcResponse<unknown>> => {
        const logEntry: TransportCallLog = {
          method,
          expectedRuntimeId: send?.expectedRuntimeId,
          expectedPairingRevision: expectedEnvironmentPairingRevision,
          forceStatusProbe: send?.forceStatusProbe,
          hadPeerWorkTarget: envelope?.orchestrationPeerWorkTarget !== undefined
        }
        transportCalls.push(logEntry)

        if (
          expectedEnvironmentPairingRevision !== undefined &&
          expectedEnvironmentPairingRevision !== livePairingRevision
        ) {
          return {
            id: method,
            ok: false,
            error: {
              code: 'runtime_environment_changed',
              message: 'Runtime environment pairing changed; refresh and try again'
            },
            _meta: { runtimeId: activeServer.runtimeId }
          }
        }
        if (method === 'status.get') {
          if (activeServer.statusError) {
            throw activeServer.statusError
          }
          logEntry.deliveredToRuntimeId = activeServer.runtimeId
          return {
            id: 'status.get',
            ok: true,
            result: {
              runtimeId: activeServer.runtimeId,
              capabilities: [...activeServer.capabilities]
            },
            _meta: { runtimeId: activeServer.runtimeId }
          }
        }

        if (onNextSend) {
          const hook = onNextSend
          onNextSend = null
          hook()
        }

        // Same-connection runtime-instance & capability verification (mirrors sendOneShotRequestOnRuntime).
        if (
          send?.expectedRuntimeId !== undefined &&
          (activeServer.runtimeId !== send.expectedRuntimeId ||
            (envelope?.orchestrationPeerWorkTarget !== undefined &&
              !activeServer.capabilities.includes(
                ORCHESTRATION_WORK_TARGET_FOLLOW_UP_RUNTIME_CAPABILITY
              )))
        ) {
          return {
            id: method,
            ok: false,
            error: {
              code: 'runtime_environment_changed',
              message: 'Runtime environment identity changed; refresh and try again'
            },
            _meta: { runtimeId: activeServer.runtimeId }
          }
        }

        logEntry.deliveredToRuntimeId = activeServer.runtimeId
        const forwarded: RpcRequest = {
          id: nextRequestId('peer'),
          authToken: 'peer-token',
          method,
          params,
          orchestrationContractVersion:
            envelope?.orchestrationContractVersion ?? ORCHESTRATION_CONTRACT_VERSION,
          ...(envelope?.orchestrationRequestId
            ? { orchestrationRequestId: envelope.orchestrationRequestId }
            : {}),
          ...(envelope?.orchestrationPeerRun
            ? { orchestrationPeerRun: envelope.orchestrationPeerRun }
            : {}),
          ...(!activeServer.stripPeerWorkTarget && envelope?.orchestrationPeerWorkTarget
            ? { orchestrationPeerWorkTarget: envelope.orchestrationPeerWorkTarget }
            : {})
        }
        const response = await activeServer.dispatcher.dispatch(forwarded, {
          clientKind: 'runtime',
          pairedDeviceId: 'dev-home-1',
          authenticatedCallerFingerprint: 'fp-home-1'
        })
        if (!response.ok) {
          return {
            id: method,
            ok: false,
            error: response.error,
            _meta: { runtimeId: activeServer.runtimeId }
          }
        }
        return {
          id: method,
          ok: true,
          result: response.result,
          _meta: { runtimeId: activeServer.runtimeId }
        }
      }
    }

    const homeFx = await createFollowUpHostFixture({
      hostRef: structuredHostRef,
      tempDirs,
      dbs,
      tag: 'home-real-transport'
    })
    const homeRuntime = new OrcaRuntimeService(homeFx.store, undefined, {
      orchestrationEnvironmentTransport: transport
    })
    homeRuntime.setOrchestrationDb(homeFx.db)
    homeFx.bindRuntimeWorkspaceStubs(homeRuntime)
    const homeDispatcher = new RpcDispatcher({
      runtime: homeRuntime,
      methods: ORCHESTRATION_METHODS
    })

    const homeRun = homeFx.db.createRun({
      objective: 'Paired runtime-pin regression',
      coordinatorHandle: BOT_ADDRESS,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: BOT_SESSION_ID
    })
    const link = openRemoteRunLink(
      homeFx.db,
      homeRun.id,
      {
        environmentId: 'env-build',
        name: 'Build Server',
        pairingRevision,
        peerFingerprint,
        homePeerFingerprint: 'fp-home-1'
      },
      () => {}
    )
    const peerRun = serverV1.db.admitPeerRun({
      peerFingerprint: 'fp-home-1',
      peerRun: {
        runId: homeRun.id,
        conversationId: link.conversation_id,
        label: 'Home Desktop'
      }
    })
    const serverAcme = seedLocalWorker(serverV1.db, {
      runId: peerRun.run_id,
      spec: 'Remote acme worker',
      worktreeId: 'wt-acme',
      terminalHandle: 'term_acme',
      paneKey: 'tab_acme:11111111-1111-4111-8111-111111111111',
      processIncarnation: 'inc-acme',
      worktreeInstanceId: 'inst-acme-1'
    })
    const serverOther = seedLocalWorker(serverV1.db, {
      runId: peerRun.run_id,
      spec: 'Remote other worker',
      worktreeId: 'wt-other',
      terminalHandle: 'term_other',
      paneKey: 'tab_other:22222222-2222-4222-8222-222222222222',
      processIncarnation: 'inc-other',
      worktreeInstanceId: 'inst-other-1'
    })
    adoptRemoteAttempt(homeFx.db, link, {
      taskId: serverAcme.taskId,
      dispatchId: serverAcme.dispatchId
    })
    adoptRemoteAttempt(homeFx.db, link, {
      taskId: serverOther.taskId,
      dispatchId: serverOther.dispatchId
    })

    installStructuredSessionHost(structuredHostRef, homeFx.records)
    const pairedTarget = makePairedTarget({ pairingRevision, peerFingerprint })
    homeRuntime.botWorkTargets.setForTurn(BOT_SESSION_ID, pairedTarget)

    // 1) Initial targeted follow-up on capable runtime #1 succeeds and pins expectedRuntimeId.
    const firstOk = await homeDispatcher.dispatch(
      rpcReq(
        'orchestration.send',
        {
          to: `dispatch:${serverAcme.dispatchId}`,
          subject: 'First follow-up',
          body: 'Run tests on acme'
        },
        { sessionId: BOT_SESSION_ID }
      )
    )
    expect(firstOk.ok).toBe(true)
    const firstSendLog = transportCalls.find((call) => call.method === 'orchestration.send')
    expect(firstSendLog).toMatchObject({
      expectedRuntimeId: serverV1.runtime.getRuntimeId(),
      expectedPairingRevision: pairingRevision,
      hadPeerWorkTarget: true,
      deliveredToRuntimeId: serverV1.runtime.getRuntimeId()
    })
    expect(serverV1.db.getUnreadMessages(`dispatch:${serverAcme.dispatchId}`)).toHaveLength(1)

    // 2) Second targeted follow-up on same capable runtime #1 reuses cached support without extra status.get.
    const statusCountBeforeSecond = transportCalls.filter((c) => c.method === 'status.get').length
    const secondOk = await homeDispatcher.dispatch(
      rpcReq(
        'orchestration.send',
        {
          to: `dispatch:${serverAcme.dispatchId}`,
          subject: 'Second follow-up',
          body: 'Continue on same instance'
        },
        { sessionId: BOT_SESSION_ID }
      )
    )
    expect(secondOk.ok).toBe(true)
    expect(transportCalls.filter((c) => c.method === 'status.get')).toHaveLength(
      statusCountBeforeSecond
    )
    expect(serverV1.db.getUnreadMessages(`dispatch:${serverAcme.dispatchId}`)).toHaveLength(2)

    // 3) Same pairing (same pairingRevision & peerFingerprint), server restarts onto an OLDER build
    // that lacks orchestration.work-target-follow-up.v1 and ignores orchestrationPeerWorkTarget!
    const serverOldRuntime = new OrcaRuntimeService(serverV1.store)
    serverOldRuntime.setOrchestrationDb(serverV1.db)
    serverV1.bindRuntimeWorkspaceStubs(serverOldRuntime)
    const oldRuntimeId = serverOldRuntime.getRuntimeId()
    expect(oldRuntimeId).not.toBe(serverV1.runtime.getRuntimeId())
    activeServer = {
      runtimeId: oldRuntimeId,
      capabilities: [
        ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
        ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY
      ],
      dispatcher: new RpcDispatcher({ runtime: serverOldRuntime, methods: ORCHESTRATION_METHODS }),
      stripPeerWorkTarget: true
    }

    const callsBeforeRollback = transportCalls.length
    expectRpcFailure(
      await homeDispatcher.dispatch(
        rpcReq(
          'orchestration.send',
          {
            to: `dispatch:${serverOther.dispatchId}`,
            subject: 'Must not leak to wrong workspace on older build',
            body: 'Secret targeted task'
          },
          { sessionId: BOT_SESSION_ID }
        )
      ),
      'capability_unsupported'
    )
    const rollbackCalls = transportCalls.slice(callsBeforeRollback)
    // Zero orchestration.send RPCs reached the older runtime instance; forced re-probe ran after invalidation.
    expect(
      rollbackCalls.filter(
        (call) => call.method === 'orchestration.send' && call.deliveredToRuntimeId === oldRuntimeId
      )
    ).toHaveLength(0)
    expect(
      rollbackCalls.some((call) => call.method === 'status.get' && call.forceStatusProbe === true)
    ).toBe(true)
    expect(serverV1.db.getUnreadMessages(`dispatch:${serverOther.dispatchId}`)).toHaveLength(0)

    // 4) Untargeted work on that same older runtime #2 STILL works normally (no regression).
    homeRuntime.botWorkTargets.clearForTurn(BOT_SESSION_ID)
    const untargetedOnOld = await homeDispatcher.dispatch(
      rpcReq(
        'orchestration.send',
        {
          to: `dispatch:${serverOther.dispatchId}`,
          subject: 'Ordinary untargeted work',
          body: 'Allowed when no target is selected'
        },
        { sessionId: BOT_SESSION_ID }
      )
    )
    expect(untargetedOnOld.ok).toBe(true)
    expect(serverV1.db.getUnreadMessages(`dispatch:${serverOther.dispatchId}`)).toHaveLength(1)

    // 5) Same pairing, server restarts onto a NEW CAPABLE build (runtime #3):
    // Cache is first warm on runtime #1, then swapped to capable runtime #3 -> invalidates & succeeds ONCE.
    homeRuntime.botWorkTargets.setForTurn(BOT_SESSION_ID, pairedTarget)
    activeServer = {
      runtimeId: serverV1.runtime.getRuntimeId(),
      capabilities: [
        ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
        ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY,
        ORCHESTRATION_WORK_TARGET_FOLLOW_UP_RUNTIME_CAPABILITY
      ],
      dispatcher: serverV1.dispatcher,
      stripPeerWorkTarget: false
    }
    // Warm cache on runtime #1 (force probe via fresh mismatch or direct send).
    const serverV3Runtime = new OrcaRuntimeService(serverV1.store)
    serverV3Runtime.setOrchestrationDb(serverV1.db)
    serverV1.bindRuntimeWorkspaceStubs(serverV3Runtime)
    const v3RuntimeId = serverV3Runtime.getRuntimeId()
    const v3Dispatcher = new RpcDispatcher({
      runtime: serverV3Runtime,
      methods: ORCHESTRATION_METHODS
    })
    // First establish cache on runtime #1 via a valid send:
    // (cache currently knows oldRuntimeId -> unsupported, so switch to v1 first via clean cache entry)
    // Simulate server currently running v1, send once to warm cache on v1, then restart to v3 right before send.
    activeServer = {
      runtimeId: serverV1.runtime.getRuntimeId(),
      capabilities: [
        ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
        ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY,
        ORCHESTRATION_WORK_TARGET_FOLLOW_UP_RUNTIME_CAPABILITY
      ],
      dispatcher: serverV1.dispatcher,
      stripPeerWorkTarget: false
    }
    // Note: cache held negative decision for oldRuntimeId; move active server to v3 with fresh runtimeId and wait-free probe.
    // Force a fresh runtime-change cycle by warming a fresh Home runtime on v1 and then switching to v3.
    const homeRuntime2 = new OrcaRuntimeService(homeFx.store, undefined, {
      orchestrationEnvironmentTransport: transport
    })
    homeRuntime2.setOrchestrationDb(homeFx.db)
    homeFx.bindRuntimeWorkspaceStubs(homeRuntime2)
    homeRuntime2.botWorkTargets.setForTurn(BOT_SESSION_ID, pairedTarget)
    const homeDispatcher2 = new RpcDispatcher({
      runtime: homeRuntime2,
      methods: ORCHESTRATION_METHODS
    })
    const beforeV1Warm = serverV1.db.getUnreadMessages(`dispatch:${serverAcme.dispatchId}`).length
    expect(
      (
        await homeDispatcher2.dispatch(
          rpcReq(
            'orchestration.send',
            {
              to: `dispatch:${serverAcme.dispatchId}`,
              subject: 'Warm cache on v1',
              body: 'Before restart'
            },
            { sessionId: BOT_SESSION_ID }
          )
        )
      ).ok
    ).toBe(true)
    expect(serverV1.db.getUnreadMessages(`dispatch:${serverAcme.dispatchId}`)).toHaveLength(
      beforeV1Warm + 1
    )

    // Restart server onto capable runtime #3 (same pairing) and send targeted follow-up.
    activeServer = {
      runtimeId: v3RuntimeId,
      capabilities: [
        ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
        ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY,
        ORCHESTRATION_WORK_TARGET_FOLLOW_UP_RUNTIME_CAPABILITY
      ],
      dispatcher: v3Dispatcher,
      stripPeerWorkTarget: false
    }
    const callsBeforeCapableRestart = transportCalls.length
    const afterCapableRestart = await homeDispatcher2.dispatch(
      rpcReq(
        'orchestration.send',
        {
          to: `dispatch:${serverAcme.dispatchId}`,
          subject: 'After restart to capable v3',
          body: 'Deliver exactly once'
        },
        { sessionId: BOT_SESSION_ID }
      )
    )
    expect(afterCapableRestart.ok).toBe(true)
    const capableRestartCalls = transportCalls.slice(callsBeforeCapableRestart)
    const deliveredToV3 = capableRestartCalls.filter(
      (call) => call.method === 'orchestration.send' && call.deliveredToRuntimeId === v3RuntimeId
    )
    expect(deliveredToV3).toHaveLength(1)
    expect(deliveredToV3[0]!.expectedRuntimeId).toBe(v3RuntimeId)
    expect(deliveredToV3[0]!.hadPeerWorkTarget).toBe(true)
    const acmeMessages = serverV1.db.getUnreadMessages(`dispatch:${serverAcme.dispatchId}`)
    expect(acmeMessages).toHaveLength(beforeV1Warm + 2)
    expect(readMessageWorkTargetProvenance(serverV1.db, acmeMessages.at(-1)!.id)).toMatchObject({
      kind: 'valid',
      sourceOrigin: `peer:${link.conversation_id}`
    })

    // 6) Uncertain / flapping runtime: server restarts before Attempt 1 AND restarts again before Attempt 2 -> fails explicitly, 0 deliveries.
    const serverV4Id = 'rt-flapping-v4'
    const serverV5Id = 'rt-flapping-v5'
    activeServer = {
      runtimeId: serverV4Id,
      capabilities: [
        ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
        ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY,
        ORCHESTRATION_WORK_TARGET_FOLLOW_UP_RUNTIME_CAPABILITY
      ],
      dispatcher: v3Dispatcher,
      stripPeerWorkTarget: false
    }
    // When Attempt 2 tries to send to v4, flip to v5 mid-flight.
    let sendCount = 0
    onNextSend = () => {
      sendCount += 1
      // Attempt 1 is still pinned to v3 and already sees v4 !== v3; arm flip for Attempt 2.
      onNextSend = () => {
        sendCount += 1
        activeServer = { ...activeServer, runtimeId: serverV5Id }
      }
    }
    const countBeforeFlap = serverV1.db.getUnreadMessages(
      `dispatch:${serverAcme.dispatchId}`
    ).length
    expectRpcFailure(
      await homeDispatcher2.dispatch(
        rpcReq(
          'orchestration.send',
          {
            to: `dispatch:${serverAcme.dispatchId}`,
            subject: 'Flapping runtime',
            body: 'Must stop without fallback or duplicate'
          },
          { sessionId: BOT_SESSION_ID }
        )
      ),
      'runtime_environment_changed'
    )
    expect(sendCount).toBe(2)
    expect(serverV1.db.getUnreadMessages(`dispatch:${serverAcme.dispatchId}`)).toHaveLength(
      countBeforeFlap
    )

    // 7) Uncertain state during forced re-probe (status.get fails after runtime change) stops explicitly with 0 deliveries.
    activeServer = { ...activeServer, statusError: new Error('socket closed mid-probe') }
    expectRpcFailure(
      await homeDispatcher2.dispatch(
        rpcReq(
          'orchestration.send',
          {
            to: `dispatch:${serverAcme.dispatchId}`,
            subject: 'Uncertain probe',
            body: 'Must fail closed'
          },
          { sessionId: BOT_SESSION_ID }
        )
      ),
      'runtime_environment_changed'
    )
    expect(serverV1.db.getUnreadMessages(`dispatch:${serverAcme.dispatchId}`)).toHaveLength(
      countBeforeFlap
    )
    activeServer = { ...activeServer, statusError: undefined }

    // 8) Pairing revision drift rejects with server_pairing_changed and zero effects.
    livePairingRevision = pairingRevision + 1
    expectRpcFailure(
      await homeDispatcher2.dispatch(
        rpcReq(
          'orchestration.send',
          {
            to: `dispatch:${serverAcme.dispatchId}`,
            subject: 'Pairing changed',
            body: 'Must fail'
          },
          { sessionId: BOT_SESSION_ID }
        )
      ),
      'server_pairing_changed'
    )
    expect(serverV1.db.getUnreadMessages(`dispatch:${serverAcme.dispatchId}`)).toHaveLength(
      countBeforeFlap
    )
    rmSync(serverDir, { recursive: true, force: true })
  })

  it('sendEnvelopedOneShotCall verifies expectedRuntimeId and follow-up capability on the exact sending WebSocket before transmitting orchestration.send', async () => {
    const keyPair = nacl.box.keyPair()
    const publicKeyB64 = Buffer.from(keyPair.publicKey).toString('base64')
    const token = 'device-token-pinned-socket'
    let serverRuntimeId = 'rt-socket-1'
    let serverCapabilities: string[] = [
      E2EE_V2_TOKEN_CAPABILITIES_RUNTIME_CAPABILITY,
      ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
      ORCHESTRATION_WORK_TARGET_FOLLOW_UP_RUNTIME_CAPABILITY
    ]
    const receivedMethods: string[] = []

    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    wss.on('connection', (ws: WebSocket) => {
      const channel = new E2EEChannel(ws, {
        serverSecretKey: keyPair.secretKey,
        resolveAuthenticatedDevice: (candidate) =>
          candidate === token
            ? {
                deviceId: 'device-socket-1',
                scope: 'runtime',
                clientId: candidate,
                callerFingerprint: 'fp-socket-home',
                credentialRevision: 0,
                deviceToken: candidate
              }
            : null,
        onReady: () => {},
        onError: (code, reason) => ws.close(code, reason)
      })
      channel.onMessage((plaintext, reply) => {
        const parsed: unknown = JSON.parse(plaintext)
        const id =
          parsed && typeof parsed === 'object' && 'id' in parsed && typeof parsed.id === 'string'
            ? parsed.id
            : ''
        const method =
          parsed &&
          typeof parsed === 'object' &&
          'method' in parsed &&
          typeof parsed.method === 'string'
            ? parsed.method
            : ''
        receivedMethods.push(method)
        const result =
          method === 'status.get'
            ? { runtimeId: serverRuntimeId, capabilities: [...serverCapabilities] }
            : { accepted: true }
        reply(JSON.stringify({ id, ok: true, result, _meta: { runtimeId: serverRuntimeId } }))
      })
      ws.on('message', (data: Buffer) => channel.handleRawMessage(data.toString()))
    })
    await new Promise<void>((resolve) => wss.once('listening', resolve))
    const addr = wss.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    try {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sendEnvelopedOneShotCall reads only id, name, and runtimeId from environment.
      const environment = {
        id: 'env-socket',
        name: 'Socket Server',
        runtimeId: 'rt-socket-1'
      } as Parameters<typeof sendEnvelopedOneShotCall>[0]['environment']
      const route = {
        environment,
        connection: {
          endpoint: `ws://127.0.0.1:${port}`,
          hostPublicKeyB64: publicKeyB64,
          credential: { kind: 'token' as const, deviceToken: token }
        }
      }
      const peerEnvelope: RuntimeOrchestrationEnvelope = {
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationPeerRun: {
          runId: 'run_sock',
          conversationId: 'peerconv_sock',
          label: 'Home'
        },
        orchestrationPeerWorkTarget: {
          mode: 'existing',
          worktreeSelector: 'identity:wt2:local:inst-acme-1',
          expectedWorkspaceInstanceId: 'inst-acme-1',
          canonicalTarget: {
            kind: 'workspace',
            hostId: 'local',
            projectId: 'proj-acme',
            repoId: 'repo-acme',
            repoKind: 'git',
            workspaceId: 'wt-acme',
            workspaceInstanceId: 'inst-acme-1',
            workspaceKind: 'git-worktree',
            displayName: 'feat/auth-fix',
            projectName: 'acme-api'
          }
        }
      }

      // 1) Matching runtimeId + capability -> transmits orchestration.send on the verified socket.
      const okResp = await sendEnvelopedOneShotCall(
        route,
        {
          method: 'orchestration.send',
          params: { to: 'dispatch:ctx_1', subject: 's', body: 'b' },
          timeoutMs: 5_000,
          envelope: peerEnvelope
        },
        'rt-socket-1'
      )
      expect(okResp.ok).toBe(true)
      expect(receivedMethods).toEqual(['status.get', 'orchestration.send'])

      // 2) Server restarted to rt-socket-2 -> same-socket status.get aborts BEFORE sending orchestration.send.
      receivedMethods.length = 0
      serverRuntimeId = 'rt-socket-2'
      const changedResp = await sendEnvelopedOneShotCall(
        route,
        {
          method: 'orchestration.send',
          params: { to: 'dispatch:ctx_1', subject: 's', body: 'b' },
          timeoutMs: 5_000,
          envelope: peerEnvelope
        },
        'rt-socket-1'
      )
      expect(changedResp).toMatchObject({
        ok: false,
        error: { code: 'runtime_environment_changed' }
      })
      expect(receivedMethods).toEqual(['status.get'])

      // 3) Server missing work-target follow-up capability on same socket -> aborts BEFORE sending orchestration.send.
      receivedMethods.length = 0
      serverRuntimeId = 'rt-socket-1'
      serverCapabilities = [
        E2EE_V2_TOKEN_CAPABILITIES_RUNTIME_CAPABILITY,
        ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY
      ]
      const missingCapResp = await sendEnvelopedOneShotCall(
        route,
        {
          method: 'orchestration.send',
          params: { to: 'dispatch:ctx_1', subject: 's', body: 'b' },
          timeoutMs: 5_000,
          envelope: peerEnvelope
        },
        'rt-socket-1'
      )
      expect(missingCapResp).toMatchObject({
        ok: false,
        error: { code: 'runtime_environment_changed' }
      })
      expect(receivedMethods).toEqual(['status.get'])
    } finally {
      for (const client of wss.clients) {
        client.terminate()
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
  })
})
