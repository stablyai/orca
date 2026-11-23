import { afterEach, describe, expect, it, vi } from 'vitest'
import { BotSchema, type Bot } from '../../shared/bot-types'
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
import {
  BotTurnWorkTargetRegistry,
  resolveBotTurnWorkTargetToWorkerStart
} from './bot-turn-work-target'
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

  afterEach(async () => {
    for (const rig of rigs.splice(0)) {
      await rig.dispose()
    }
  })

  function buildWiredHost(options: {
    workTargets: BotTurnWorkTargetRegistry
    resolveWorkspace: (selector: string) => BotWorkTargetWorkspaceSummary | null
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
      }
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
    const rig = await createQueuedMessageTestRig({
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'folder:fw-bot-home',
        workspaceKind: 'folder'
      },
      hostDeps: {
        validateWorkTarget: wiring.validateWorkTarget,
        turnContext: wiring.turnContext
      }
    })
    rigs.push(rig)
    const unsubscribeTurnEnd = rig.host.subscribeTurnCompletions({
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
    try {
      // 1) Start an active untargeted turn.
      const firstId = await rig.workingSend()
      await rig.settleAccepted(firstId, 'turn-1')
      const turn1 = turnIdentity('turn-1')
      rig
        .providerEvents()
        .appendItem(
          turn1,
          { kind: 'turn', turnId: 'turn-1', state: 'running' },
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
      await eventually(async () => {
        expect((await rig.host.currentWork(SESSION))?.activeTurnId()).toBe('turn-1')
      })
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
      rig.providerEvents().appendLifecycleBatch!(
        'turn-completed:turn-1',
        [
          {
            kind: 'item',
            identity: turn1,
            body: {
              kind: 'turn',
              turnId: 'turn-1',
              state: 'completed',
              outcome: 'success',
              completedAt: NOW
            },
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          }
        ],
        { lifecycle: true }
      )
      await eventually(() => {
        expect(rig.dispatch).toHaveBeenCalledTimes(3)
      })
      const targetedDispatch = rig.dispatch.mock.calls[2]?.[0]
      expect(blockText(targetedDispatch?.body.blocks[0])).toContain(
        '--worktree identity:wt2:local:inst-auth-1'
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
      rig.providerEvents().appendLifecycleBatch!(
        'turn-completed:turn-2',
        [
          {
            kind: 'item',
            identity: turn2,
            body: {
              kind: 'turn',
              turnId: 'turn-2',
              state: 'completed',
              outcome: 'success',
              completedAt: NOW + 1
            },
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          }
        ],
        { lifecycle: true }
      )
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
    const rig = await createQueuedMessageTestRig({
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'folder:fw-bot-home',
        workspaceKind: 'folder'
      },
      hostDeps: {
        validateWorkTarget: wiring.validateWorkTarget,
        turnContext: wiring.turnContext
      }
    })
    rigs.push(rig)
    const unsubscribeTurnEnd = rig.host.subscribeTurnCompletions({
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
    try {
      const firstId = await rig.workingSend()
      await rig.settleAccepted(firstId, 'turn-1')
      const turn1 = turnIdentity('turn-1')
      rig
        .providerEvents()
        .appendItem(
          turn1,
          { kind: 'turn', turnId: 'turn-1', state: 'running' },
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
      await eventually(async () => {
        expect((await rig.host.currentWork(SESSION))?.activeTurnId()).toBe('turn-1')
      })

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
      rig.providerEvents().appendLifecycleBatch!(
        'turn-completed:turn-1',
        [
          {
            kind: 'item',
            identity: turn1,
            body: {
              kind: 'turn',
              turnId: 'turn-1',
              state: 'completed',
              outcome: 'success',
              completedAt: NOW
            },
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          }
        ],
        { lifecycle: true }
      )
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

  it('resolves bot turn placement both when worker-start omits flags and when it echoes matching flags while preserving explicit untargeted destinations', () => {
    const projectPlacement = {
      mode: 'new-top-level' as const,
      repoSelector: 'id:repo-acme-local',
      targetHostId: 'local' as const,
      canonicalTarget: {
        kind: 'project' as const,
        hostId: 'local',
        repoId: 'repo-acme-local',
        repoKind: 'git' as const,
        displayName: 'acme-api'
      }
    }
    // Omitted flags -> rewritten + enforced.
    expect(
      resolveBotTurnWorkTargetToWorkerStart({ worktree: 'current' }, projectPlacement, false)
    ).toEqual({
      params: { repo: 'id:repo-acme-local', worktree: 'new-top-level' },
      enforcement: projectPlacement
    })
    // Matching explicit flags from <orca_context> -> still enforced.
    expect(
      resolveBotTurnWorkTargetToWorkerStart(
        { repo: 'id:repo-acme-local', worktree: 'new-top-level' },
        projectPlacement,
        false
      )
    ).toEqual({
      params: { repo: 'id:repo-acme-local', worktree: 'new-top-level' },
      enforcement: projectPlacement
    })
    // Untargeted turn -> explicitly different destination preserved untouched.
    expect(
      resolveBotTurnWorkTargetToWorkerStart(
        { repo: 'id:repo-other', worktree: 'new-top-level', on: 'env-other' },
        undefined,
        false
      )
    ).toEqual({
      params: { repo: 'id:repo-other', worktree: 'new-top-level', on: 'env-other' }
    })
  })
})
