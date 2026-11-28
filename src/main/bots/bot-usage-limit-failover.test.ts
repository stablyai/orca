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
import type { HostUsageLimitCut } from '../native-chat/agent-session-wire/recovery/structured-agent-session-usage-limit-chain'

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
  observeCut: (id: string, cut: HostUsageLimitCut) => Promise<void>
  editBot: (updates: BotHostUpdates) => void
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

function createHarness(
  initialBot: Bot,
  initialLinks: ExternalConversationLink[] = [],
  overrides: Partial<BotUsageLimitFailoverDeps> = {}
): Harness {
  let bot = initialBot
  const cuts = new Map<string, HostUsageLimitCut>()
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
    availableAgents: async () => new Set<BotAgent>(['claude', 'codex', 'antigravity']),
    applySameAgentOptions: async (sessionId, target) => {
      const current = sessions.get(sessionId)
      if (!current) {
        return null
      }
      sameAgentApplies.push({ sessionId, model: target.model })
      sessions.set(sessionId, { ...current, model: target.model })
      return { target, complete: true }
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
    readSessionCut: async (id) => cuts.get(id) ?? null,
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
        await input.beforeFirstMessage?.()
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
        return { complete: true, messages: new Map() }
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
    },
    ...overrides
  }

  const failover = new BotUsageLimitFailover(deps)
  return {
    gate,
    failover,
    observeCut: (id, cut) => {
      cuts.set(id, cut)
      return failover.onUsageLimitCut(id, cut)
    },
    editBot: (updates) => {
      bot = applyBotUpdates(bot, updates)
    },
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

    await h.observeCut('session-home', { turnItemId: 'turn-1', resetsAt, chain: 1 })

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
    await h.observeCut('session-slack', {
      turnItemId: 'turn-1',
      resetsAt: NOW + 600_000,
      chain: 1
    })
    expect(h.getBot().activeBackup?.target.model).toBe('claude-haiku-4-5')

    // Cut 2 on Backup 1 cascades cross-agent to Backup 2 (codex / gpt-5-codex).
    await h.observeCut('session-slack', {
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

    await h.observeCut('session-home', {
      turnItemId: 'turn-ask',
      resetsAt: NOW + 600_000,
      chain: 1
    })
    expect(h.sameAgentApplies).toEqual([])
    expect(h.failover.readCutBackupState('session-home', 'turn-ask')).toMatchObject({
      backupState: 'ask-backup'
    })

    await expect(
      h.failover.switchSessionManually({
        botId: 'bot-1',
        sessionId: 'session-home',
        turnItemId: 'old-turn',
        target: { agent: 'codex' },
        remember: true
      })
    ).rejects.toThrow('usage_limit_cut_changed')
    expect(h.getBot().backupModels?.automatic).toBe(false)

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

  it('skips a delisted model and keeps a launched backup inactive if the primary recovered', async () => {
    const h = createHarness(createBot(), [], {
      isBackupModelOffered: async (_bot, target) => target.agent === 'codex'
    })
    const primary = {
      agent: 'claude' as const,
      accountHomeKey: 'acct-a',
      model: 'claude-sonnet-4-5',
      resetsAt: NOW + 600_000
    }
    h.gate.recordLimit(primary)

    const resolved = await h.failover.resolveLaunchSetup(h.getBot())
    expect(resolved.agent).toBe('codex')
    expect(resolved.launch?.model).toBe('gpt-5-codex')
    expect(h.getBot().activeBackup).toBeUndefined()
    h.gate.recordSuccess(primary)
    await resolved.markActive?.()
    expect(h.getBot().activeBackup).toBeUndefined()
    h.gate.dispose()
  })

  it('offers a backup instead of switching when the owner turns on asking during discovery', async () => {
    const checking = Promise.withResolvers<void>()
    const available = Promise.withResolvers<ReadonlySet<BotAgent>>()
    const h = createHarness(createBot(), [], {
      availableAgents: () => {
        checking.resolve()
        return available.promise
      }
    })
    const observed = h.observeCut('session-home', { turnItemId: 'turn-1', chain: 1 })
    await checking.promise
    h.editBot({
      backupModels: { automatic: false, order: [{ agent: 'codex', model: 'gpt-5-codex' }] }
    })
    available.resolve(new Set(['codex']))
    await observed
    expect(h.failover.readCutBackupState('session-home', 'turn-1')?.backupState).toBe('ask-backup')
    expect(h.startedSessions).toEqual([])
    h.gate.dispose()
  })

  it('keeps the applied backup when its continuation is refused', async () => {
    const h = createHarness(createBot(), [], { sendSameAgentContinuation: async () => false })
    await h.observeCut('session-home', {
      turnItemId: 'turn-1',
      resetsAt: NOW + 600_000,
      chain: 1
    })
    expect(h.getBot().activeBackup?.target).toEqual({ agent: 'claude', model: 'claude-haiku-4-5' })
    expect(h.startedSessions).toEqual([])
    h.gate.dispose()
  })

  it('does not change the session or try a second backup when recording the switch fails', async () => {
    const h = createHarness(createBot(), [], {
      updateBot: async () => {
        throw new Error('storage offline')
      }
    })
    await h.observeCut('session-home', { turnItemId: 'turn-1', chain: 1 })
    expect(h.sessions.get('session-home')?.model).toBe('claude-sonnet-4-5')
    expect(h.startedSessions).toEqual([])
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

  it('rejects session/bot mismatches, recovers failed switches, defers forced return while busy, and restores unset launch.model', async () => {
    const h = createHarness(
      createBot({
        launch: undefined,
        backupModels: {
          automatic: true,
          order: [
            { agent: 'claude' },
            { agent: 'claude', model: 'claude-haiku-4-5' },
            { agent: 'codex', model: 'gpt-5-codex' }
          ]
        }
      })
    )
    h.sessions.set('session-home', {
      sessionId: 'session-home',
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      isIdle: true,
      runtimeFence: 1
    })

    // Rejects switching a session that does not belong to the requested bot.
    await expect(
      h.failover.switchSessionManually({
        botId: 'bot-1',
        sessionId: 'unknown-session',
        turnItemId: 'turn-1',
        target: { agent: 'codex', model: 'gpt-5-codex' }
      })
    ).rejects.toThrow('session_not_found')

    // Automatic cut skips model-less same-agent entry and switches to claude-haiku-4-5.
    await h.observeCut('session-home', {
      turnItemId: 'turn-1',
      resetsAt: NOW + 600_000,
      chain: 1
    })
    expect(h.getBot().activeBackup?.target).toEqual({ agent: 'claude', model: 'claude-haiku-4-5' })
    expect(h.getBot().activeBackup?.primaryModel).toBe('claude-sonnet-4-5')

    // A forced return requested while busy survives an interrupted turn.
    h.sessions.set('session-home', { ...h.sessions.get('session-home')!, isIdle: false })
    expect(await h.failover.returnToPrimary('bot-1', { force: true })).toBe(false)
    expect(h.getBot().activeBackup).toBeDefined()

    h.sessions.set('session-home', { ...h.sessions.get('session-home')!, isIdle: true })
    await h.failover.onTurnInterrupted('session-home')
    expect(h.getBot().activeBackup).toBeUndefined()
    expect(h.sameAgentApplies.at(-1)).toEqual({
      sessionId: 'session-home',
      model: 'claude-sonnet-4-5'
    })
    expect(h.switchCards.at(-1)?.item).toMatchObject({
      direction: 'to-primary',
      returnReason: 'manual',
      toModel: 'claude-sonnet-4-5'
    })
    h.gate.dispose()
  })
})
