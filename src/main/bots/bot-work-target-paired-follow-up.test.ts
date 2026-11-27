import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as StructuredRegistry from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { ResolvedBotWorkTargetPlacement } from '../../shared/agent-session/work-target/agent-session-work-target'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION,
  ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY,
  ORCHESTRATION_RUNTIME_CAPABILITIES,
  ORCHESTRATION_WORK_TARGET_FOLLOW_UP_RUNTIME_CAPABILITY
} from '../../shared/orchestration/orchestration-runtime-capabilities'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { readMessageWorkTargetProvenance } from '../runtime/orchestration/db/messages/message-work-target-provenance'
import { adoptRemoteAttempt } from '../runtime/orchestration/db/remote-owned/remote-placements'
import { openRemoteRunLink } from '../runtime/orchestration/db/remote-owned/remote-run-links'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'
import type { RpcRequest } from '../runtime/rpc/core'
import {
  BOT_ADDRESS,
  BOT_SESSION_ID,
  createFollowUpHostFixture,
  expectRpcFailure,
  installStructuredSessionHost,
  makeExplicitWorkspaceTarget,
  makeProjectTarget,
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

describe('paired remote-owned, legacy federated, peer mail, non-work, and hidden follow-up paths', () => {
  it('enforces target & pairing identity on paired remote-owned follow-ups (dual real dispatchers), refuses older paired servers and legacy federated/peer-mail paths with zero side effects', async () => {
    const home = await createFollowUpHostFixture({
      hostRef: structuredHostRef,
      tempDirs,
      dbs,
      tag: 'home'
    })
    const server = await createFollowUpHostFixture({
      hostRef: structuredHostRef,
      tempDirs,
      dbs,
      tag: 'server'
    })

    const homeRun = home.db.createRun({
      objective: 'Paired follow-up test',
      coordinatorHandle: BOT_ADDRESS,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: BOT_SESSION_ID
    })

    let serverPairingRevision = 7
    let serverPeerFingerprint = 'fp-server-v7'
    let serverCapabilities: readonly string[] = [...ORCHESTRATION_RUNTIME_CAPABILITIES]
    const serverRpcCalls: { method: string; peerWorkTarget?: unknown }[] = []

    const resolveServerSpy = vi
      .spyOn(home.runtime, 'resolveOrchestrationWorkerServer')
      .mockImplementation(async (selector) => {
        if (selector !== 'env-build' && selector !== 'Build Server') {
          throw new Error(`Unknown server: ${selector}`)
        }
        return {
          environmentId: 'env-build',
          name: 'Build Server',
          pairingRevision: serverPairingRevision,
          peerFingerprint: serverPeerFingerprint
        }
      })

    // Bridge Home -> Server through Server's real RpcDispatcher + admitOrchestrationPeerCall.
    const callServerSpy = vi
      .spyOn(home.runtime, 'callOrchestrationWorkerServer')
      .mockImplementation(async (_envId, method, params, _timeoutMs, envelope) => {
        serverRpcCalls.push({
          method,
          ...(envelope?.orchestrationPeerWorkTarget
            ? { peerWorkTarget: envelope.orchestrationPeerWorkTarget }
            : {})
        })
        if (method === 'status.get') {
          return {
            runtimeId: server.runtime.getRuntimeId(),
            capabilities: [...serverCapabilities]
          }
        }
        const forwarded: RpcRequest = {
          id: nextRequestId('peer'),
          authToken: 'peer-token',
          method,
          params,
          orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
          ...(envelope?.orchestrationRequestId
            ? { orchestrationRequestId: envelope.orchestrationRequestId }
            : {}),
          ...(envelope?.orchestrationPeerRun
            ? { orchestrationPeerRun: envelope.orchestrationPeerRun }
            : {}),
          ...(envelope?.orchestrationPeerWorkTarget
            ? { orchestrationPeerWorkTarget: envelope.orchestrationPeerWorkTarget }
            : {})
        }
        const response = await server.dispatcher.dispatch(forwarded, {
          clientKind: 'runtime',
          pairedDeviceId: 'dev-home-1',
          authenticatedCallerFingerprint: 'fp-home-1'
        })
        if (!response.ok) {
          throw new OrchestrationError(
            response.error.code,
            response.error.message,
            response.error.data
          )
        }
        return response.result
      })

    const link = openRemoteRunLink(
      home.db,
      homeRun.id,
      {
        environmentId: 'env-build',
        name: 'Build Server',
        pairingRevision: 7,
        peerFingerprint: 'fp-server-v7'
      },
      () => {}
    )
    const peerRun = server.db.admitPeerRun({
      peerFingerprint: 'fp-home-1',
      peerRun: {
        runId: homeRun.id,
        conversationId: link.conversation_id,
        label: 'Home Mac'
      }
    })

    const serverAcme = seedLocalWorker(server.db, {
      runId: peerRun.run_id,
      spec: 'Remote acme worker',
      worktreeId: 'wt-acme',
      terminalHandle: 'term_acme',
      paneKey: 'tab_acme:11111111-1111-4111-8111-111111111111',
      processIncarnation: 'inc-server-acme',
      worktreeInstanceId: 'inst-acme-1'
    })
    const serverOther = seedLocalWorker(server.db, {
      runId: peerRun.run_id,
      spec: 'Remote other worker',
      worktreeId: 'wt-other',
      terminalHandle: 'term_other',
      paneKey: 'tab_other:22222222-2222-4222-8222-222222222222',
      processIncarnation: 'inc-server-other',
      worktreeInstanceId: 'inst-other-1'
    })
    adoptRemoteAttempt(home.db, link, {
      taskId: serverAcme.taskId,
      dispatchId: serverAcme.dispatchId
    })
    adoptRemoteAttempt(home.db, link, {
      taskId: serverOther.taskId,
      dispatchId: serverOther.dispatchId
    })

    installStructuredSessionHost(structuredHostRef, home.records)

    // 1) Local target active -> remote-owned worker refuses BEFORE server lookup or remote RPC.
    home.runtime.botWorkTargets.setForTurn(BOT_SESSION_ID, makeExplicitWorkspaceTarget())
    expectRpcFailure(
      await home.dispatcher.dispatch(
        rpcReq(
          'orchestration.send',
          { to: `dispatch:${serverAcme.dispatchId}`, subject: 'Mismatch host', body: 'Fail' },
          { sessionId: BOT_SESSION_ID }
        )
      ),
      'invalid_argument'
    )
    expect(resolveServerSpy).not.toHaveBeenCalled()
    expect(callServerSpy).not.toHaveBeenCalled()

    // 2) Paired target active, pairingRevision drifted (7 -> 8) -> refuses BEFORE any remote RPC.
    const pairedAcmeTarget: ResolvedBotWorkTargetPlacement = {
      mode: 'existing',
      worktreeSelector: 'identity:wt2:local:inst-acme-1',
      onEnvironmentId: 'env-build',
      onExpectedPairingRevision: 7,
      onExpectedPeerFingerprint: 'fp-server-v7',
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
        pairingRevision: 7,
        peerFingerprint: 'fp-server-v7'
      }
    }
    home.runtime.botWorkTargets.setForTurn(BOT_SESSION_ID, pairedAcmeTarget)
    serverPairingRevision = 8
    expectRpcFailure(
      await home.dispatcher.dispatch(
        rpcReq(
          'orchestration.send',
          { to: `dispatch:${serverAcme.dispatchId}`, subject: 'Stale pairing', body: 'Fail' },
          { sessionId: BOT_SESSION_ID }
        )
      ),
      'server_pairing_changed'
    )
    expect(callServerSpy).not.toHaveBeenCalled()
    serverPairingRevision = 7

    // 3) Older paired server lacking orchestration.work-target-follow-up.v1 -> refuses BEFORE orchestration.send.
    serverCapabilities = [ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY]
    expectRpcFailure(
      await home.dispatcher.dispatch(
        rpcReq(
          'orchestration.send',
          { to: `dispatch:${serverAcme.dispatchId}`, subject: 'Older server', body: 'Fail' },
          { sessionId: BOT_SESSION_ID }
        )
      ),
      'capability_unsupported'
    )
    expect(serverRpcCalls.some((call) => call.method === 'orchestration.send')).toBe(false)
    expect(server.db.getUnreadMessages(`dispatch:${serverAcme.dispatchId}`)).toHaveLength(0)

    // 4) Capable paired server advertising orchestration.work-target-follow-up.v1.
    serverPeerFingerprint = 'fp-server-v7-cap'
    serverCapabilities = [
      ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY,
      ORCHESTRATION_WORK_TARGET_FOLLOW_UP_RUNTIME_CAPABILITY
    ]
    home.db.db
      .prepare(
        'UPDATE remote_run_links SET peer_fingerprint = ?, home_fingerprint = ? WHERE conversation_id = ?'
      )
      .run(serverPeerFingerprint, serverPeerFingerprint, link.conversation_id)
    home.runtime.botWorkTargets.setForTurn(BOT_SESSION_ID, {
      ...pairedAcmeTarget,
      onExpectedPeerFingerprint: serverPeerFingerprint,
      canonicalTarget: {
        ...pairedAcmeTarget.canonicalTarget,
        peerFingerprint: serverPeerFingerprint
      }
    })

    // 4a) Matching remote worker succeeds AND persists durable provenance on Server SQLite DB.
    const pairedOkResp = await home.dispatcher.dispatch(
      rpcReq(
        'orchestration.send',
        {
          to: `dispatch:${serverAcme.dispatchId}`,
          subject: 'Verified remote follow-up',
          body: 'Continue on Build Server'
        },
        { sessionId: BOT_SESSION_ID }
      )
    )
    expect(pairedOkResp.ok).toBe(true)
    const serverAcmeUnread = server.db.getUnreadMessages(`dispatch:${serverAcme.dispatchId}`)
    expect(serverAcmeUnread).toHaveLength(1)
    expect(readMessageWorkTargetProvenance(server.db, serverAcmeUnread[0]!.id)).toMatchObject({
      kind: 'valid',
      sourceOrigin: `peer:${link.conversation_id}`
    })

    // 4b) Mismatched remote worker on Server is rejected on Server with ZERO mail stored.
    expectRpcFailure(
      await home.dispatcher.dispatch(
        rpcReq(
          'orchestration.send',
          {
            to: `dispatch:${serverOther.dispatchId}`,
            subject: 'Wrong remote workspace',
            body: 'Must fail on server'
          },
          { sessionId: BOT_SESSION_ID }
        )
      ),
      'invalid_argument'
    )
    expect(server.db.getUnreadMessages(`dispatch:${serverOther.dispatchId}`)).toHaveLength(0)

    // 4c) Non-peer caller attempting to spoof orchestrationPeerWorkTarget is refused immediately.
    expectRpcFailure(
      await server.dispatcher.dispatch(
        rpcReq(
          'orchestration.send',
          { to: `dispatch:${serverAcme.dispatchId}`, subject: 'Spoof', body: 'Bad' },
          { extra: { orchestrationPeerWorkTarget: makeExplicitWorkspaceTarget() } }
        )
      ),
      'mail_requires_server_pairing'
    )

    // 5) Legacy federated worker (`federated_dispatches`) & `send --on` bare peer mail.
    const legacyFed = home.db.createStartingWorkerDispatch({
      creator: { kind: 'terminal', handle: BOT_ADDRESS, orcaSessionId: BOT_SESSION_ID },
      maxDepth: 3,
      taskSpec: 'Legacy federated worker',
      taskRunId: homeRun.id,
      startOptions: { on: 'env-build', worktree: 'id:wt-acme' },
      runtimeEpoch: 'runtime-epoch-1',
      federation: {
        environmentId: 'env-build',
        environmentName: 'Build Server',
        peerFingerprint: serverPeerFingerprint,
        protocolVersion: ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION
      }
    })
    home.db.markWorkerDispatchReady(legacyFed.dispatch.id)

    expectRpcFailure(
      await home.dispatcher.dispatch(
        rpcReq(
          'orchestration.send',
          {
            to: `dispatch:${legacyFed.dispatch.id}`,
            subject: 'Legacy follow-up',
            body: 'Should not enqueue'
          },
          { sessionId: BOT_SESSION_ID }
        )
      ),
      'capability_unsupported'
    )
    const countRelayItems = (dispatchId: string): number => {
      const row: unknown = home.db.db
        .prepare('SELECT COUNT(*) AS count FROM federation_relay_items WHERE dispatch_id = ?')
        .get(dispatchId)
      return typeof row === 'object' &&
        row !== null &&
        'count' in row &&
        typeof row.count === 'number'
        ? row.count
        : -1
    }
    expect(countRelayItems(legacyFed.dispatch.id)).toBe(0)

    const callsBeforePeerMail = callServerSpy.mock.calls.length
    expectRpcFailure(
      await home.dispatcher.dispatch(
        rpcReq(
          'orchestration.send',
          {
            on: 'env-build',
            to: 'term_remote_bare',
            subject: 'Bare peer work',
            body: 'Should refuse'
          },
          { sessionId: BOT_SESSION_ID }
        )
      ),
      'capability_unsupported'
    )
    expect(callServerSpy.mock.calls.length).toBe(callsBeforePeerMail)

    // Untargeted turn preserves legacy federated control mail behavior.
    home.runtime.botWorkTargets.clearForTurn(BOT_SESSION_ID)
    expect(
      (
        await home.dispatcher.dispatch(
          rpcReq(
            'orchestration.send',
            {
              to: `dispatch:${legacyFed.dispatch.id}`,
              subject: 'Untargeted legacy mail',
              body: 'Works as before'
            },
            { sessionId: BOT_SESSION_ID }
          )
        )
      ).ok
    ).toBe(true)
    expect(countRelayItems(legacyFed.dispatch.id)).toBe(1)
  })

  it('preserves untargeted work, non-work status/question/read calls, and enforces work targets on hidden orchestration.dispatch and sendGroupMessage paths', async () => {
    const fx = await createFollowUpHostFixture({
      hostRef: structuredHostRef,
      tempDirs,
      dbs,
      tag: 'hidden-paths'
    })
    const run = fx.db.createRun({
      objective: 'Hidden paths and non-work preservation',
      coordinatorHandle: BOT_ADDRESS,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: BOT_SESSION_ID
    })
    const wOther = seedLocalWorker(fx.db, {
      runId: run.id,
      spec: 'Other worker',
      worktreeId: 'wt-other',
      terminalHandle: 'term_other',
      paneKey: 'tab_other:22222222-2222-4222-8222-222222222222',
      processIncarnation: 'inc-other',
      worktreeInstanceId: 'inst-other-1'
    })

    // 1) Untargeted send works unchanged.
    expect(
      (
        await fx.dispatcher.dispatch(
          rpcReq(
            'orchestration.send',
            { to: `dispatch:${wOther.dispatchId}`, subject: 'Untargeted', body: 'Allowed' },
            { sessionId: BOT_SESSION_ID }
          )
        )
      ).ok
    ).toBe(true)

    // 2) Targeted turn active: non-work messages (question, coordinator run status) & reads stay allowed.
    fx.runtime.botWorkTargets.setForTurn(BOT_SESSION_ID, makeProjectTarget())

    expect(
      (
        await fx.dispatcher.dispatch(
          rpcReq(
            'orchestration.send',
            {
              to: `dispatch:${wOther.dispatchId}`,
              type: 'question',
              subject: 'Clarifying question',
              body: 'What branch are you on?'
            },
            { sessionId: BOT_SESSION_ID }
          )
        )
      ).ok
    ).toBe(true)

    const otherRun = fx.db.createRun({
      objective: 'Peer coordinator run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:99999999-9999-4999-8999-999999999999'
    })
    expect(
      (
        await fx.dispatcher.dispatch(
          rpcReq(
            'orchestration.send',
            {
              to: `run:${otherRun.id}`,
              type: 'status',
              subject: 'Run update',
              body: 'Progress note'
            },
            { sessionId: BOT_SESSION_ID }
          )
        )
      ).ok
    ).toBe(true)

    expect(
      (
        await fx.dispatcher.dispatch(
          rpcReq(
            'orchestration.workerShow',
            { dispatch: wOther.dispatchId },
            { sessionId: BOT_SESSION_ID }
          )
        )
      ).ok
    ).toBe(true)

    // 3) Hidden path: orchestration.dispatch to a terminal in wt-other refuses with zero dispatches.
    const task = fx.db.createTask({ spec: 'Hidden dispatch work', runId: run.id })
    expectRpcFailure(
      await fx.dispatcher.dispatch(
        rpcReq(
          'orchestration.dispatch',
          { task: task.id, to: 'term_other', inject: false },
          { sessionId: BOT_SESSION_ID }
        )
      ),
      'invalid_argument'
    )
    expect(fx.db.getDispatchContext(task.id)).toBeUndefined()

    // 4) Hidden path: group fan-out (@all) containing a worker in wt-other refuses with zero messages stored.
    const messagesBeforeGroup = fx.db.getUnreadMessages(`dispatch:${wOther.dispatchId}`).length
    expectRpcFailure(
      await fx.dispatcher.dispatch(
        rpcReq(
          'orchestration.send',
          { to: '@all', subject: 'Broadcast work', body: 'Do work everywhere' },
          { sessionId: BOT_SESSION_ID }
        )
      ),
      'invalid_argument'
    )
    expect(fx.db.getUnreadMessages(`dispatch:${wOther.dispatchId}`)).toHaveLength(
      messagesBeforeGroup
    )
  })
})
