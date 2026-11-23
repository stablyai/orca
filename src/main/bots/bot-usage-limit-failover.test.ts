import { describe, expect, it } from 'vitest'
import type { Bot, BotAgent } from '../../shared/bot-types'
import type { AgentJournalBotBackupModelSwitchItem } from '../../shared/agent-journal-orca-card-items'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { applyBotUpdates, type BotHostUpdates } from '../../shared/rpc-contract/bots-params'
import type { BotConversationActsFor } from '../runtime/orchestration/db/bot-requests/bot-conversation-acts-for-store'
import { BotUsageLimitGate } from './bot-usage-limit-gate'
import {
  BotUsageLimitFailover,
  type BotFailoverSessionInfo,
  type BotUsageLimitFailoverDeps
} from './bot-usage-limit-failover'
import { buildBotFailoverHandoffPrompt } from './bot-cross-agent-handoff'
import { botPackageFor } from './sharing/bot-package-export'
import {
  BOT_BACKUP_RETURN_METHOD,
  BOT_BACKUP_SWITCH_METHOD
} from '../runtime/rpc/methods/bots-backup-models'
import { LOCAL_CLI_RPC_CALLER } from '../runtime/rpc/callers/rpc-caller-identity'
import type { RpcContext } from '../runtime/rpc/core'

const NOW = 1_750_000_000_000

function createBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1',
    hostId: 'local',
    name: 'Ops Bot',
    folder: 'ops-bot',
    folderWorkspaceId: 'folder-1',
    avatar: null,
    paused: false,
    agent: 'claude',
    launch: { model: 'claude-sonnet-4-5' },
    chatSessionId: 'session-home',
    backupModels: {
      automatic: true,
      order: [
        { agent: 'claude', model: 'claude-haiku-4-5' },
        { agent: 'codex', model: 'gpt-5-codex' }
      ]
    },
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    linear: null,
    github: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides
  }
}

type Harness = {
  gate: BotUsageLimitGate
  failover: BotUsageLimitFailover
  getBot: () => Bot
  sessions: Map<string, BotFailoverSessionInfo>
  switchCards: { sessionId: string; item: AgentJournalBotBackupModelSwitchItem }[]
  sameAgentApplies: { sessionId: string; model?: string }[]
  sameAgentContinuations: string[]
  startedSessions: {
    bot: Bot
    sessionId: string
    actsFor?: BotConversationActsFor
    text: string
  }[]
  queuedCarries: { from: string; to: string }[]
  closedHomeChats: string[]
  reboundLinks: ExternalConversationLink[]
  handedOff: { from: string; to: string }[]
  actsForBySession: Map<string, BotConversationActsFor>
}

function createHarness(initialBot: Bot, initialLinks: ExternalConversationLink[] = []): Harness {
  let bot = initialBot
  const sessions = new Map<string, BotFailoverSessionInfo>([
    [
      initialBot.chatSessionId ?? 'session-home',
      {
        sessionId: initialBot.chatSessionId ?? 'session-home',
        provider: initialBot.agent,
        model: initialBot.launch?.model,
        isIdle: true,
        runtimeFence: 1
      }
    ]
  ])
  const switchCards: Harness['switchCards'] = []
  const sameAgentApplies: Harness['sameAgentApplies'] = []
  const sameAgentContinuations: string[] = []
  const startedSessions: Harness['startedSessions'] = []
  const queuedCarries: Harness['queuedCarries'] = []
  const closedHomeChats: string[] = []
  const links = [...initialLinks]
  const handedOff: Harness['handedOff'] = []
  const actsForBySession = new Map<string, BotConversationActsFor>()

  const gate = new BotUsageLimitGate({ now: () => NOW })
  const deps: BotUsageLimitFailoverDeps = {
    gate,
    now: () => NOW,
    listBots: () => [bot],
    botOfSession: (sessionId) => (sessions.has(sessionId) ? bot : null),
    updateBot: async (_botId, edit: (current: Bot) => BotHostUpdates) => {
      bot = applyBotUpdates(bot, edit(bot))
      return bot
    },
    getSessionInfo: async (sessionId) => sessions.get(sessionId) ?? null,
    resolveAccountHomeKey: async () => 'acct-a',
    availableAgents: async () => new Set<BotAgent>(['claude', 'codex', 'gemini']),
    applySameAgentOptions: async (sessionId, target) => {
      const current = sessions.get(sessionId)
      if (!current) {
        return false
      }
      sameAgentApplies.push({ sessionId, model: target.model })
      sessions.set(sessionId, { ...current, model: target.model })
      return true
    },
    sendSameAgentContinuation: async (sessionId) => {
      sameAgentContinuations.push(sessionId)
      return true
    },
    appendSwitchCard: async (sessionId, item) => {
      switchCards.push({ sessionId, item })
    },
    publishSessionStatus: () => {},
    listBotSessionIds: () => [...sessions.keys()],
    readSessionCut: async () => null,
    crossAgentHandoff: {
      readContinuationContext: async () => ({
        status: 'current',
        capturedText:
          'Recent turn with token sk-ant-secret12345678901234567890 and Bearer my-secret-jwt-token-value'
      }),
      readConversationName: () => 'Release Thread',
      isBackgroundSession: () => false,
      isTabVisible: () => true,
      readActsFor: (sessionId) => actsForBySession.get(sessionId) ?? null,
      startSession: async (botOnTarget, input) => {
        startedSessions.push({
          bot: botOnTarget,
          sessionId: input.sessionId,
          actsFor: input.actsFor,
          text: input.text
        })
        sessions.set(input.sessionId, {
          sessionId: input.sessionId,
          provider: botOnTarget.agent,
          model: botOnTarget.launch?.model,
          isIdle: true,
          runtimeFence: 1
        })
        if (input.actsFor) {
          actsForBySession.set(input.sessionId, input.actsFor)
        }
        return input.sessionId
      },
      setHomeChatSession: async (_botId, sessionId) => {
        bot = { ...bot, chatSessionId: sessionId }
      },
      carryQueuedMessages: async (from, to) => {
        queuedCarries.push({ from, to })
      },
      closeOldHomeChat: async (sessionId) => {
        closedHomeChats.push(sessionId)
      },
      showTab: async () => {},
      nameSession: async () => {},
      appendSwitchCard: async (sessionId, item) => {
        switchCards.push({ sessionId, item })
      },
      linkStore: () => ({
        getRepos: () => [],
        getAllWorktreeMeta: () => ({}),
        getWorktreeMeta: () => undefined,
        setWorktreeMeta: () => {},
        getFolderWorkspaces: () => [{ id: 'folder-1', externalConversations: [...links] }],
        getFolderWorkspace: () => ({ externalConversations: [...links] }),
        updateFolderWorkspace: (_id, update) => {
          links.splice(0, links.length, ...(update.externalConversations ?? []))
        }
      }),
      onSessionHandedOff: (from, to) => {
        handedOff.push({ from, to })
      }
    }
  }

  return {
    gate,
    failover: new BotUsageLimitFailover(deps),
    getBot: () => bot,
    sessions,
    switchCards,
    sameAgentApplies,
    sameAgentContinuations,
    startedSessions,
    queuedCarries,
    closedHomeChats,
    reboundLinks: links,
    handedOff,
    actsForBySession
  }
}

describe('BotUsageLimitFailover invariants and security boundaries', () => {
  it('switches in-place for same-agent backups, preserves configured primary, and returns to primary when idle', async () => {
    const h = createHarness(createBot())
    const resetsAt = NOW + 600_000

    await h.failover.onUsageLimitCut('session-home', { turnItemId: 'turn-1', resetsAt, chain: 1 })

    expect(h.sameAgentApplies).toEqual([{ sessionId: 'session-home', model: 'claude-haiku-4-5' }])
    expect(h.sameAgentContinuations).toEqual(['session-home'])
    expect(h.switchCards).toHaveLength(1)
    expect(h.switchCards[0].item).toMatchObject({
      kind: 'bot-backup-model-switch',
      direction: 'to-backup',
      fromAgent: 'claude',
      fromModel: 'claude-sonnet-4-5',
      toAgent: 'claude',
      toModel: 'claude-haiku-4-5'
    })
    // Configured primary stays intact; runtime failover state lives in activeBackup.
    expect(h.getBot().agent).toBe('claude')
    expect(h.getBot().launch?.model).toBe('claude-sonnet-4-5')
    expect(h.getBot().activeBackup).toMatchObject({
      target: { agent: 'claude', model: 'claude-haiku-4-5' },
      primaryModel: 'claude-sonnet-4-5'
    })

    // While session is busy, returning waits instead of interrupting mid-turn.
    h.sessions.set('session-home', { ...h.sessions.get('session-home')!, isIdle: false })
    h.gate.clearAccount('claude', 'acct-a')
    await h.failover.returnToPrimary('bot-1')
    expect(h.getBot().activeBackup).toBeDefined()

    // Once the turn finishes and session is idle, return applies primary automatically.
    h.sessions.set('session-home', { ...h.sessions.get('session-home')!, isIdle: true })
    await h.failover.onTurnSucceeded('session-home')
    expect(h.getBot().activeBackup).toBeUndefined()
    expect(h.sameAgentApplies.at(-1)).toEqual({
      sessionId: 'session-home',
      model: 'claude-sonnet-4-5'
    })
    h.gate.dispose()
  })

  it('cascades Backup 1 -> Backup 2 across agents, preserves non-owner actsFor, redacts secrets, and rebinds connector links', async () => {
    const connectorLink: ExternalConversationLink = {
      source: 'slack',
      externalId: 'C123:1700.0001',
      sessionId: 'session-slack',
      agent: 'claude',
      paneKey: 'pane-1',
      bot: { botId: 'bot-1', kind: 'bot' },
      createdAt: 1_700_000_000_000
    }
    const botChatLink: ExternalConversationLink = {
      source: 'slack',
      externalId: 'C123:1700.0002',
      sessionId: 'session-slack',
      agent: 'claude',
      paneKey: 'pane-2',
      bot: { botId: 'bot-1', kind: 'bot-chat' },
      createdAt: 1_700_000_000_000
    }
    const nonOwnerAuthority: BotConversationActsFor = {
      actsFor: [
        {
          kind: 'person',
          source: 'slack',
          userId: 'U_GUEST_42',
          name: 'Guest User',
          workspaceId: 'T1',
          role: 'member'
        }
      ]
    }
    const h = createHarness(createBot(), [connectorLink, botChatLink])
    h.sessions.set('session-slack', {
      sessionId: 'session-slack',
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      isIdle: true,
      runtimeFence: 1
    })
    h.actsForBySession.set('session-slack', nonOwnerAuthority)

    // Cut 1 fails over in-place to Backup 1 (claude-haiku-4-5).
    await h.failover.onUsageLimitCut('session-slack', {
      turnItemId: 'turn-1',
      resetsAt: NOW + 600_000,
      chain: 1
    })
    expect(h.getBot().activeBackup?.target.model).toBe('claude-haiku-4-5')

    // Cut 2 on Backup 1 cascades cross-agent to Backup 2 (codex / gpt-5-codex).
    await h.failover.onUsageLimitCut('session-slack', {
      turnItemId: 'turn-2',
      resetsAt: NOW + 900_000,
      chain: 2
    })

    expect(h.startedSessions).toHaveLength(1)
    const handoff = h.startedSessions[0]
    expect(handoff.bot.agent).toBe('codex')
    expect(handoff.bot.launch?.model).toBe('gpt-5-codex')
    // Security invariant: actsFor preserved verbatim, never escalated to owner.
    expect(handoff.actsFor).toEqual(nonOwnerAuthority)
    // Security invariant: secret tokens stripped before cross-agent prompt.
    expect(handoff.text).not.toContain('sk-ant-secret12345678901234567890')
    expect(handoff.text).not.toContain('my-secret-jwt-token-value')
    // Connector link rebound; bot-chat link untouched.
    expect(h.reboundLinks.find((l) => l.externalId === 'C123:1700.0001')?.sessionId).toBe(
      handoff.sessionId
    )
    expect(h.reboundLinks.find((l) => l.externalId === 'C123:1700.0002')?.sessionId).toBe(
      'session-slack'
    )
    expect(h.handedOff).toEqual([{ from: 'session-slack', to: handoff.sessionId }])
    // Original configured primary must never be overwritten during cascading failover.
    expect(h.getBot().agent).toBe('claude')
    expect(h.getBot().activeBackup?.primaryModel).toBe('claude-sonnet-4-5')
    h.gate.dispose()
  })

  it('publishes ask-backup when automatic is false and remembers manual selection when remember=true', async () => {
    const bot = createBot({
      backupModels: {
        automatic: false,
        order: [
          { agent: 'claude', model: 'claude-haiku-4-5' },
          { agent: 'codex', model: 'gpt-5-codex' }
        ]
      }
    })
    const h = createHarness(bot)

    await h.failover.onUsageLimitCut('session-home', {
      turnItemId: 'turn-ask',
      resetsAt: NOW + 600_000,
      chain: 1
    })
    expect(h.sameAgentApplies).toEqual([])
    expect(h.failover.readCutBackupState('session-home', 'turn-ask')).toMatchObject({
      backupState: 'ask-backup'
    })

    const result = await h.failover.switchSessionManually({
      botId: 'bot-1',
      sessionId: 'session-home',
      turnItemId: 'turn-ask',
      target: { agent: 'codex', model: 'gpt-5-codex' },
      remember: true
    })
    expect(result.switched).toBe(true)
    expect(h.getBot().backupModels).toEqual({
      automatic: true,
      order: [
        { agent: 'codex', model: 'gpt-5-codex' },
        { agent: 'claude', model: 'claude-haiku-4-5' }
      ]
    })
    h.gate.dispose()
  })

  it('pre-routes resolveLaunchSetup to ready backup when primary is currently held', async () => {
    const h = createHarness(createBot())
    h.gate.recordLimit({
      agent: 'claude',
      accountHomeKey: 'acct-a',
      model: 'claude-sonnet-4-5',
      resetsAt: NOW + 600_000
    })

    const resolved = await h.failover.resolveLaunchSetup(h.getBot())
    expect(resolved.agent).toBe('claude')
    expect(resolved.launch?.model).toBe('claude-haiku-4-5')
    h.gate.dispose()
  })

  it('redacts secrets in handoff prompts, excludes backups from botPackageFor, and rejects agent callers via ownerOnly', async () => {
    const prompt = buildBotFailoverHandoffPrompt({
      sourceAgent: 'claude',
      direction: 'to-backup',
      context: {
        status: 'current',
        capturedText: 'ANTHROPIC_API_KEY=sk-ant-api03-secretvalue1234567890',
        transcriptPath: '/synthetic/private/transcript.jsonl'
      }
    })
    expect(prompt).not.toContain('sk-ant-api03-secretvalue1234567890')
    expect(prompt).not.toContain('/synthetic/private/transcript.jsonl')

    const exported = botPackageFor(
      createBot(),
      {
        soul: '# Ops Bot',
        purpose: 'Monitors releases',
        avatar: undefined,
        avatarImage: null,
        skills: [],
        tools: [],
        schedules: [],
        eventSuggestions: [],
        memory: [],
        leftOut: [],
        connectors: []
      },
      {}
    )
    expect('backupModels' in exported).toBe(false)
    expect('activeBackup' in exported).toBe(false)

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ownerOnly inspects only caller identity before touching runtime.
    const agentContext = { caller: LOCAL_CLI_RPC_CALLER } as RpcContext
    await expect(
      BOT_BACKUP_SWITCH_METHOD.handler(
        {
          botId: 'bot-1',
          sessionId: 'session-home',
          turnItemId: 'turn-1',
          target: { agent: 'codex', model: 'gpt-5-codex' }
        },
        agentContext
      )
    ).rejects.toThrow('Only the owner')
    await expect(
      BOT_BACKUP_RETURN_METHOD.handler({ botId: 'bot-1' }, agentContext)
    ).rejects.toThrow('Only the owner')
  })
})
