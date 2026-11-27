import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BotSchema, type Bot } from '../../shared/bot-types'
import {
  addEnvironmentFromPairingCode,
  resolveEnvironment
} from '../../shared/remote-runtime/host-store/runtime-environment-store-operations'
import { refreshEnvironmentFromResumePairingCode } from '../../shared/remote-runtime/host-store/runtime-environment-resume-pairing-operations'
import { encodePairingOffer } from '../../shared/remote-runtime/pairing/pairing'
import { getPreferredPairingOffer } from '../../shared/remote-runtime/host-catalog/runtime-environments'
import { fingerprintOrchestrationPeer } from '../runtime/orchestration/federation/environment-transport'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../shared/agent-session/journal/agent-session-journal-identity'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionSendFields } from '../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { readWholeAgentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'
import { agentSessionWriteNoticeEnglish } from '../../shared/agent-session/failures/agent-session-refusal-notice'
import { structuredAgentSessionAttemptFailureParts } from '../../shared/agent-session/failures/structured-agent-session-rejection-words'
import type { NativeChatBlock } from '../../shared/native-chat/native-chat-types'
import type { Repo } from '../../shared/repository/repo-types'
import { createWorktreeIdentity } from '../../shared/worktree/identity'
import type { AgentSessionHandoverContext } from '../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import { StructuredAgentSessionInputNotAdmitted } from '../native-chat/agent-session-wire/delivery/structured-agent-session-input-admission'
import { structuredAgentSessionRideAlong } from '../native-chat/agent-session-wire/structured-agent-session-ride-along'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestOperationId
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { createBotMemoryRecord } from './bot-memory-record'
import { botStructuredSessionWiring } from './bot-structured-session-wiring'
import type { BotChatJournal } from './bot-turn-rows'
import { BotTurnWorkTargetRegistry } from './bot-turn-work-target'
import {
  validateBotWorkTarget,
  type BotWorkTargetValidationDeps,
  type BotWorkTargetWorkspaceSummary
} from './bot-work-target-validation'

function makeBot(id: string, folderWorkspaceId: string): Bot {
  return BotSchema.parse({
    id,
    name: 'HelperBot',
    hostId: 'local',
    folder: 'helper-bot',
    folderWorkspaceId,
    agent: 'codex',
    avatar: null,
    paused: false,
    notifications: {
      needsPermission: false,
      taskComplete: false,
      couldNotFinish: false
    },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId: SESSION,
    createdAt: 1,
    updatedAt: 1
  })
}

function makeSessionLocation(
  workspaceId: string,
  workspaceKind: 'folder' | 'git-worktree' = 'folder'
): Pick<AgentSessionRecord, 'location'> {
  return {
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId,
      workspaceKind
    }
  }
}

function blockText(block: NativeChatBlock | undefined): string {
  return block?.type === 'text' ? block.text : ''
}

function makeWorkspace(
  overrides: Partial<BotWorkTargetWorkspaceSummary> &
    Pick<BotWorkTargetWorkspaceSummary, 'id' | 'repoId' | 'displayName' | 'path'>
): BotWorkTargetWorkspaceSummary {
  const hostId = overrides.hostId ?? 'local'
  const instanceId = overrides.instanceId
  return {
    branch: overrides.displayName,
    isArchived: false,
    hostId,
    ...(instanceId
      ? {
          instanceId,
          identity: createWorktreeIdentity({
            worktreeId: overrides.id,
            executionHostId: hostId,
            instanceId
          })
        }
      : {}),
    ...overrides
  }
}

describe('active-turn opens-next-turn enforcement through real journal, queue, and delivery loop', () => {
  const rigs: QueuedMessageTestRig[] = []
  const tempDirs: string[] = []

  afterEach(async () => {
    for (const rig of rigs.splice(0)) {
      await rig.dispose()
    }
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  function buildWiredHost(options: {
    workTargets: BotTurnWorkTargetRegistry
    resolveWorkspace: (selector: string) => BotWorkTargetWorkspaceSummary | null
    resolveOrchestrationWorkerServer?: BotWorkTargetValidationDeps['resolveOrchestrationWorkerServer']
    callOrchestrationWorkerServer?: BotWorkTargetValidationDeps['callOrchestrationWorkerServer']
  }) {
    const localGitRepo: Repo = {
      id: 'repo-acme-local',
      displayName: 'acme-api',
      path: '/synth/local/acme-api',
      badgeColor: '',
      addedAt: 1,
      kind: 'git',
      executionHostId: 'local'
    }
    const deps: BotWorkTargetValidationDeps = {
      hostId: 'local',
      isBotHome: (workspaceId) => workspaceId === 'folder:fw-bot-home',
      store: () => ({
        getBots: () => [makeBot('bot-1', 'fw-bot-home')],
        getRepos: () => [localGitRepo],
        getFolderWorkspaces: () => [],
        getProjectGroups: () => []
      }),
      showManagedTerminalWorkspace: async (selector) => {
        if (selector === 'id:wt-auth') {
          const current = options.resolveWorkspace(selector)
          if (!current) {
            throw new Error('selector_not_found')
          }
          return current
        }
        throw new Error('selector_not_found')
      },
      ...(options.resolveOrchestrationWorkerServer
        ? { resolveOrchestrationWorkerServer: options.resolveOrchestrationWorkerServer }
        : {}),
      ...(options.callOrchestrationWorkerServer
        ? { callOrchestrationWorkerServer: options.callOrchestrationWorkerServer }
        : {})
    }
    const memory = createBotMemoryRecord({
      readText: async () => null,
      replaceText: async () => true,
      writeText: async () => true
    })
    const chats: BotChatJournal = {
      sourcesAfter: async () => ({ owner: false, labels: [], places: [], urls: [] }),
      turnRanSince: async () => false
    }
    const wiring = botStructuredSessionWiring({
      store: () => ({
        getBots: () => [makeBot('bot-1', 'fw-bot-home')],
        getRepos: () => [localGitRepo]
      }),
      bots: { endFirstRun: async () => undefined, memory },
      chats,
      work: {
        turnNote: vi.fn(async () => 'Conflicting prior worker note'),
        handedOver: vi.fn(),
        turnEnded: vi.fn()
      },
      lookAround: {
        botOfLook: () => null,
        botOfTidyUp: () => null,
        lookTurnIsQuiet: () => false
      },
      workTargets: options.workTargets,
      validateWorkTarget: (record, target) => validateBotWorkTarget(deps, record, target),
      sessionRecord: (sessionId) =>
        sessionId === SESSION ? makeSessionLocation('folder:fw-bot-home', 'folder') : null
    })
    return { deps, wiring }
  }

  function sendWithBody(
    rig: QueuedMessageTestRig,
    body: AgentJournalMessageItem,
    delivery?: 'queue-if-active'
  ) {
    const clientOperationId = hostTestOperationId()
    const fields = agentSessionSendFields({ body, ...(delivery ? { delivery } : {}) })
    return {
      id: clientOperationId,
      result: rig.host.send(QUEUED_RIG_CALLER, {
        envelope: rig.envelope(fields, 'agentSession.send', clientOperationId),
        ...(delivery ? { delivery } : {}),
        body,
        userSend: true as const
      })
    }
  }

  function turnIdentity(turnId: string): AgentJournalItemIdentity {
    return { provider: 'codex', threadId: THREAD, turnId, ordinal: 1 }
  }

  async function createBotHomeRig(
    wiring: ReturnType<typeof buildWiredHost>['wiring'],
    options?: { subscribeTurnEnd?: boolean }
  ) {
    const rig = await createQueuedMessageTestRig({
      restartable: true,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'folder:fw-bot-home',
        workspaceKind: 'folder'
      },
      probeOwner: async () => ({ outcome: 'pid-absent' }),
      hostDeps: {
        validateWorkTarget: wiring.validateWorkTarget,
        turnContext: wiring.turnContext
      }
    })
    rigs.push(rig)
    const unsubscribeTurnEnd = options?.subscribeTurnEnd
      ? rig.host.subscribeTurnCompletions({
          id: 'test-host-turn-context',
          emit: (event) => {
            if (event.type === 'completion') {
              wiring.turnContext.turnEnded?.(
                event.completion.sessionId,
                event.completion.turnId,
                async () => ({ items: [], openerIds: new Map() }),
                undefined,
                { outcome: event.completion.outcome }
              )
            }
          }
        })
      : () => {}
    return { rig, unsubscribeTurnEnd }
  }

  async function startActiveTurn(rig: QueuedMessageTestRig, turnId: string) {
    const firstId = await rig.workingSend()
    await rig.settleAccepted(firstId, turnId)
    const identity = turnIdentity(turnId)
    rig
      .providerEvents()
      .appendItem(
        identity,
        { kind: 'turn', turnId, state: 'running' },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    await eventually(async () => {
      expect((await rig.host.currentWork(SESSION))?.activeTurnId()).toBe(turnId)
    })
    return identity
  }

  function completeTurn(
    rig: QueuedMessageTestRig,
    identity: AgentJournalItemIdentity,
    turnId: string,
    completedAt = NOW
  ) {
    rig.providerEvents().appendLifecycleBatch!(
      `turn-completed:${turnId}`,
      [
        {
          kind: 'item',
          identity,
          body: { kind: 'turn', turnId, state: 'completed', outcome: 'success', completedAt },
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      ],
      { lifecycle: true }
    )
  }

  it('queues targeted sends (even on Steer default), refuses queued Send-now while working with recoverable attachments, preserves unselected steering, and delivers with target once idle', async () => {
    const workTargets = new BotTurnWorkTargetRegistry()
    const currentAuthWorkspace = makeWorkspace({
      id: 'wt-auth',
      repoId: 'repo-acme-local',
      hostId: 'local',
      instanceId: 'inst-auth-1',
      displayName: 'feat/auth-fix',
      path: '/synth/local/acme-api-auth'
    })
    const { wiring } = buildWiredHost({
      workTargets,
      resolveWorkspace: () => currentAuthWorkspace
    })
    const { rig, unsubscribeTurnEnd } = await createBotHomeRig(wiring, { subscribeTurnEnd: true })
    try {
      // 1) Start an active untargeted turn.
      const turn1 = await startActiveTurn(rig, 'turn-1')
      expect(rig.dispatch).toHaveBeenCalledTimes(1)

      // 2) Send a targeted message WITHOUT delivery='queue-if-active' (Steer-default / alternate steer path) + image attachment.
      const targetedBody: AgentJournalMessageItem = {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text: 'Run auth tests [Image #1]' },
          { type: 'image-ref', path: '/synth/uploads/failure.png' }
        ],
        workTarget: {
          kind: 'workspace',
          hostId: 'local',
          repoId: 'repo-acme-local',
          workspaceId: 'wt-auth',
          workspaceKind: 'git-worktree',
          displayName: 'feat/auth-fix'
        }
      }
      const targeted = sendWithBody(rig, targetedBody)
      const targetedReply = await targeted.result
      expect(targetedReply).toMatchObject({
        ok: true,
        value: { queued: { messageId: targeted.id, state: 'waiting' } }
      })

      // Never handed to the running turn; stored card carries canonical workTarget (with instanceId) and steers is absent.
      expect(rig.dispatch).toHaveBeenCalledTimes(1)
      const historyWhileWorking = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
      expect(historyWhileWorking.ok).toBe(true)
      if (!historyWhileWorking.ok) {
        throw new Error('history failed')
      }
      const queuedCard = historyWhileWorking.page.queuedMessages?.find(
        (card) => card.messageId === targeted.id
      )
      expect(queuedCard).toMatchObject({
        messageId: targeted.id,
        state: 'waiting',
        body: {
          blocks: targetedBody.blocks,
          workTarget: {
            workspaceId: 'wt-auth',
            workspaceInstanceId: 'inst-auth-1'
          }
        }
      })
      expect(queuedCard?.steers).toBeUndefined()

      // 3) Queued Send-now on the targeted card while turn-1 is running must be explicitly refused with card intact.
      const sendNowRefused = await rig.sendNow(targeted.id)
      expect(sendNowRefused).toMatchObject({
        ok: false,
        refusal: {
          code: 'agent_session_operation_invalid',
          details: { reason: 'turnActive' }
        }
      })
      expect(rig.dispatch).toHaveBeenCalledTimes(1)
      expect(await rig.drafts()).toContainEqual({ messageId: targeted.id, state: 'waiting' })

      // 4) An unselected message still steers into the running turn normally (existing behavior preserved).
      const plainSteer = rig.send('quick hint while working')
      expect(await plainSteer.result).toMatchObject({
        ok: true,
        value: { queued: { messageId: plainSteer.id, state: 'waiting' } }
      })
      await eventually(() => {
        expect(rig.dispatch).toHaveBeenCalledTimes(2)
      })
      const steerCall = rig.dispatch.mock.calls[1]?.[0]
      expect(blockText(steerCall?.body.blocks[0])).toBe('quick hint while working')
      const steerHandoff = await rig.handoffId(plainSteer.id)
      await rig.settleAccepted(steerHandoff, 'turn-1-steer')

      // 5) Complete turn-1 -> idle handover automatically delivers the targeted card on a fresh turn with <orca_context>.
      completeTurn(rig, turn1, 'turn-1')
      await eventually(() => {
        expect(rig.dispatch).toHaveBeenCalledTimes(3)
      })
      const targetedDispatch = rig.dispatch.mock.calls[2]?.[0]
      expect(blockText(targetedDispatch?.body.blocks[0])).toContain(
        '--worktree identity:wt2:local:inst-auth-1'
      )
      expect(blockText(targetedDispatch?.body.blocks[0])).not.toContain(
        'Conflicting prior worker note'
      )
      expect(blockText(targetedDispatch?.body.blocks[1])).toContain('Run auth tests [Image #1]')
      expect(targetedDispatch?.body.blocks[2]).toEqual({
        type: 'image-ref',
        path: '/synth/uploads/failure.png'
      })
      expect(workTargets.getForTurn(SESSION)).toMatchObject({
        mode: 'existing',
        worktreeSelector: 'identity:wt2:local:inst-auth-1',
        targetHostId: 'local',
        expectedWorkspaceInstanceId: 'inst-auth-1'
      })

      // Turn completion clears active turn target so subsequent turns do not inherit it.
      const targetedHandoffId = await rig.handoffId(targeted.id)
      await rig.settleAccepted(targetedHandoffId, 'turn-2')
      const turn2 = turnIdentity('turn-2')
      rig
        .providerEvents()
        .appendItem(
          turn2,
          { kind: 'turn', turnId: 'turn-2', state: 'running' },
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
      completeTurn(rig, turn2, 'turn-2', NOW + 1)
      await eventually(() => {
        expect(workTargets.getForTurn(SESSION)).toBeUndefined()
      })
    } finally {
      unsubscribeTurnEnd()
    }
  })

  it('rejects targeted handover on delete/recreate while queued (preserving text + attachments on returned card) and fails closed on active-turn ride-along scope', async () => {
    const workTargets = new BotTurnWorkTargetRegistry()
    let occupantInstanceId = 'inst-auth-1'
    const { wiring } = buildWiredHost({
      workTargets,
      resolveWorkspace: () =>
        makeWorkspace({
          id: 'wt-auth',
          repoId: 'repo-acme-local',
          hostId: 'local',
          instanceId: occupantInstanceId,
          displayName: 'feat/auth-fix',
          path: '/synth/local/acme-api-auth'
        })
    })
    const { rig, unsubscribeTurnEnd } = await createBotHomeRig(wiring, { subscribeTurnEnd: true })
    try {
      const turn1 = await startActiveTurn(rig, 'turn-1')

      // Enqueue while occupant is inst-auth-1.
      const queued = sendWithBody(
        rig,
        {
          kind: 'message',
          role: 'user',
          blocks: [
            { type: 'text', text: 'Check recreated path [Image #1]' },
            { type: 'image-ref', path: '/synth/uploads/snap.png' }
          ],
          workTarget: {
            kind: 'workspace',
            hostId: 'local',
            repoId: 'repo-acme-local',
            workspaceId: 'wt-auth',
            workspaceKind: 'git-worktree',
            displayName: 'feat/auth-fix'
          }
        },
        'queue-if-active'
      )
      expect(await queued.result).toMatchObject({
        ok: true,
        value: { queued: { messageId: queued.id, state: 'waiting' } }
      })

      // Delete and recreate worktree at the exact same path -> new occupant instanceId!
      occupantInstanceId = 'inst-auth-recreated-2'

      // Finish turn-1 -> idle drain re-validates and rejects without ever calling provider dispatch.
      completeTurn(rig, turn1, 'turn-1')
      await eventually(async () => {
        const page = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
        expect(page.ok).toBe(true)
        if (!page.ok) {
          return
        }
        const card = page.page.queuedMessages?.find((entry) => entry.messageId === queued.id)
        expect(card?.state).toBe('returned')
        expect(card?.body.blocks).toEqual([
          { type: 'text', text: 'Check recreated path [Image #1]' },
          { type: 'image-ref', path: '/synth/uploads/snap.png' }
        ])
        expect(card?.body.workTarget).toMatchObject({
          workspaceId: 'wt-auth',
          workspaceInstanceId: 'inst-auth-1'
        })
        const notice = agentSessionWriteNoticeEnglish(
          structuredAgentSessionAttemptFailureParts(
            { kind: 'rejected', reason: card?.returnedReason ?? null },
            {},
            readWholeAgentSessionFailureFact(card?.returnedRejection)
          )
        )
        expect(notice).toContain('The selected project or workspace is no longer available.')
      })
      expect(rig.dispatch).toHaveBeenCalledTimes(1)
      expect(workTargets.getForTurn(SESSION)).toBeUndefined()

      // Defense-in-depth: direct active-turn scope on structuredAgentSessionRideAlong fails closed (never strips workTarget).
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ride-along only accesses reads.automationResultNotes and appendItem in this direct-scope check.
      const journalStub = {
        reads: { automationResultNotes: async () => ({ items: [], submissions: [] }) },
        appendItem: async () => ({
          itemId: 'item-1',
          sequence: 1,
          cursor: { epoch: 'e', sequence: 1 }
        })
      } as unknown as AgentSessionHandoverContext['journal']
      const activeTurnSubmission: AgentJournalSubmission = {
        clientMessageId: 'msg-active',
        fence: 1,
        payloadFingerprint: 'fp-active',
        dispatchState: 'pending',
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: null
      }
      const rideAlong = structuredAgentSessionRideAlong(
        { sessionId: SESSION, journal: journalStub, turnContext: wiring.turnContext },
        activeTurnSubmission,
        {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'Should never strip target' }],
          workTarget: {
            kind: 'project',
            hostId: 'local',
            repoId: 'repo-acme-local',
            displayName: 'acme-api'
          }
        }
      )
      let activeTurnError: unknown
      try {
        await rideAlong.claim(1, { kind: 'turn', turnItemId: 'codex:thread:turn-1:1' })
      } catch (error) {
        activeTurnError = error
      }
      expect(activeTurnError).toBeInstanceOf(StructuredAgentSessionInputNotAdmitted)
      if (!(activeTurnError instanceof StructuredAgentSessionInputNotAdmitted)) {
        throw new Error('expected StructuredAgentSessionInputNotAdmitted')
      }
      expect(activeTurnError.outcome).toMatchObject({
        state: 'rejected',
        rejection: {
          kind: 'notDelivered',
          neverReachedAgent: true,
          refusal: {
            code: 'agent_session_operation_invalid',
            details: { reason: 'turnActive' }
          }
        }
      })
    } finally {
      unsubscribeTurnEnd()
    }
  })

  it('persists host-authored paired-server pins through queue and disk restart, rejects replacement VM at handover with zero RPC calls and recoverable card, and preserves untargeted delivery', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'orca-work-target-env-'))
    tempDirs.push(userDataPath)
    const oldKeyB64 = Buffer.alloc(32, 0x11).toString('base64')
    const newKeyB64 = Buffer.alloc(32, 0x22).toString('base64')
    const oldPairingCode = encodePairingOffer({
      v: 2,
      endpoint: 'wss://old-vm.example:9443',
      publicKeyB64: oldKeyB64,
      deviceToken: 'tok-old-vm',
      scope: 'runtime'
    })
    const env = addEnvironmentFromPairingCode(userDataPath, {
      name: 'Build Server',
      pairingCode: oldPairingCode,
      now: 1_700_000_000_000
    })
    const originalPairingRevision = env.pairingRevision ?? env.createdAt
    const originalPeerFingerprint = fingerprintOrchestrationPeer(oldKeyB64)

    const remoteCalls: { envId: string; method: string; params: unknown }[] = []
    const workTargets = new BotTurnWorkTargetRegistry()
    const { wiring } = buildWiredHost({
      workTargets,
      resolveWorkspace: () => null,
      resolveOrchestrationWorkerServer: async (selector) => {
        const resolved = resolveEnvironment(userDataPath, selector)
        const offer = getPreferredPairingOffer(resolved)
        return {
          environmentId: resolved.id,
          name: resolved.name,
          pairingRevision: resolved.pairingRevision ?? resolved.createdAt,
          peerFingerprint: fingerprintOrchestrationPeer(offer.publicKeyB64)
        }
      },
      callOrchestrationWorkerServer: async (envId, method, params) => {
        remoteCalls.push({ envId, method, params })
        if (method === 'repo.list') {
          // Both the original and rebuilt replacement VM expose the exact same repoId!
          return {
            repos: [
              {
                id: 'remote-acme',
                displayName: 'acme-api',
                path: '/srv/acme-api',
                badgeColor: '',
                addedAt: 1,
                kind: 'git',
                executionHostId: 'local'
              }
            ]
          }
        }
        return {}
      }
    })
    const { rig } = await createBotHomeRig(wiring)

    // 1) Start an active untargeted turn.
    await startActiveTurn(rig, 'turn-1')

    // 2) Queue a paired-server targeted message (even passing a forged client pin, which admission must overwrite with host state).
    const queued = sendWithBody(
      rig,
      {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text: 'Deploy build [Image #1]' },
          { type: 'image-ref', path: '/synth/uploads/build.png' }
        ],
        workTarget: {
          kind: 'project',
          hostId: `runtime:${env.id}`,
          repoId: 'remote-acme',
          displayName: 'acme-api',
          pairingRevision: 1,
          peerFingerprint: 'fp-untrusted-renderer'
        }
      },
      'queue-if-active'
    )
    expect(await queued.result).toMatchObject({
      ok: true,
      value: { queued: { messageId: queued.id, state: 'waiting' } }
    })
    expect(remoteCalls).toHaveLength(1)

    // 3) Simulate a full host crash/restart from SQLite on disk -> journal replay MUST retain the host-authored pin.
    await rig.crashRestartHostFromDisk()
    const afterReload = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
    expect(afterReload.ok).toBe(true)
    if (!afterReload.ok) {
      throw new Error('history after reload failed')
    }
    const reloadedCard = afterReload.page.queuedMessages?.find(
      (entry) => entry.messageId === queued.id
    )
    expect(reloadedCard?.body.workTarget).toMatchObject({
      hostId: `runtime:${env.id}`,
      repoId: 'remote-acme',
      pairingRevision: originalPairingRevision,
      peerFingerprint: originalPeerFingerprint
    })

    // 4) Replace the VM under the EXACT SAME environmentId using real refreshEnvironmentFromResumePairingCode.
    const replacedPairingCode = encodePairingOffer({
      v: 2,
      endpoint: 'wss://rebuilt-vm.example:9443',
      publicKeyB64: newKeyB64,
      deviceToken: 'tok-rebuilt-vm',
      scope: 'runtime'
    })
    const refreshed = refreshEnvironmentFromResumePairingCode(userDataPath, env.id, {
      pairingCode: replacedPairingCode,
      now: 1_700_000_005_000
    })
    expect(refreshed.environment.id).toBe(env.id)
    expect(refreshed.reusedPairing).toBe(false)
    expect(refreshed.environment.pairingRevision).toBeGreaterThan(originalPairingRevision)

    // Clear remote call log before handover so ANY call to the replacement server fails the test immediately.
    remoteCalls.length = 0
    const dispatchesBeforeHandover = rig.dispatch.mock.calls.length

    // 5) Trigger idle handover on the reloaded host -> MUST expire with ZERO calls to the replacement server and preserve text/attachments/selection!
    const retryReply = await rig.sendNow(queued.id)
    expect(retryReply).toMatchObject({ ok: true })
    await eventually(async () => {
      const page = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
      expect(page.ok).toBe(true)
      if (!page.ok) {
        return
      }
      const card = page.page.queuedMessages?.find((entry) => entry.messageId === queued.id)
      expect(card?.state).toBe('returned')
      expect(card?.body.blocks).toEqual([
        { type: 'text', text: 'Deploy build [Image #1]' },
        { type: 'image-ref', path: '/synth/uploads/build.png' }
      ])
      expect(card?.body.workTarget).toMatchObject({
        kind: 'project',
        hostId: `runtime:${env.id}`,
        repoId: 'remote-acme',
        displayName: 'acme-api',
        pairingRevision: originalPairingRevision,
        peerFingerprint: originalPeerFingerprint
      })
      expect(card?.returnedRejection).toMatchObject({
        kind: 'notDelivered',
        neverReachedAgent: true,
        refusal: {
          code: 'agent_session_operation_invalid',
          details: { reason: 'workTargetExpired' }
        }
      })
      const notice = agentSessionWriteNoticeEnglish(
        structuredAgentSessionAttemptFailureParts(
          { kind: 'rejected', reason: card?.returnedReason ?? null },
          {},
          readWholeAgentSessionFailureFact(card?.returnedRejection)
        )
      )
      expect(notice).toContain('expired')
      expect(notice).toContain('paired server')
    })
    expect(remoteCalls).toHaveLength(0)
    expect(rig.dispatch).toHaveBeenCalledTimes(dispatchesBeforeHandover)
    expect(workTargets.getForTurn(SESSION)).toBeUndefined()

    // 6) Plain untargeted message after reload still delivers normally with no target context.
    const plainAfterReload = rig.send('untargeted after reload')
    expect(await plainAfterReload.result).toMatchObject({ ok: true })
    await eventually(() => {
      expect(rig.dispatch).toHaveBeenCalledTimes(dispatchesBeforeHandover + 1)
    })
    expect(blockText(rig.dispatch.mock.calls.at(-1)?.[0]?.body.blocks[0])).toBe(
      'untargeted after reload'
    )
    expect(remoteCalls).toHaveLength(0)
  })
})
