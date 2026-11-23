// Reads host-side backup model availability, catalog options, and re-arms startup primary returns.
import type { Bot, BotAgent } from '../../shared/bot-types'
import {
  botPrimaryTarget,
  effectiveBotSetup,
  type BotBackupCatalogOption,
  type BotBackupModelAvailability,
  type BotBackupStatusResult
} from '../../shared/bots/bot-backup-models'
import { botOnSetup } from '../../shared/bots/bot-agent-setup'
import { isTuiAgent } from '../../shared/agent-launch/catalog/tui-agent-config'
import { agentPickerModels } from '../../shared/agent-launch/picker/agent-launch-picker-catalog'
import { keptSetupCatalog } from '../../shared/agent-launch/picker/agent-launch-kept-setup-catalog'
import { structuredModelEfforts } from '../../shared/agent-session/options/model-catalog/structured-agent-session-discovered-model'
import type { StructuredAgentSessionBotBackupHook } from '../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import type { AgentSessionModelCatalogResult } from '../../shared/agent-session/agent-session-wire'
import type { AgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service-contract'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { BotUsageLimitGate } from './bot-usage-limit-gate'
import type { BotUsageLimitFailover } from './bot-usage-limit-failover'
import {
  peekRuntimeBotBackupFailover,
  runtimeBotBackupFailover,
  type RuntimeBotBackupFailover
} from './bot-usage-limit-failover-runtime'

export type BotBackupStatusReaderDeps = {
  runtime: OrcaRuntimeService
  gate: BotUsageLimitGate
  availableAgents: () => Promise<ReadonlySet<BotAgent>>
  resolveAccountHomeKey: (agent: BotAgent, sessionId?: string) => Promise<string>
  onCatalogWarmed?: () => void
}

const warmingCatalogAgents = new WeakMap<OrcaRuntimeService, Set<BotAgent>>()

function demandCatalogOnce(
  deps: BotBackupStatusReaderDeps,
  catalog: Pick<AgentModelCatalogService, 'demand' | 'read'>,
  agent: BotAgent,
  previous: AgentSessionModelCatalogResult | null
): void {
  let active = warmingCatalogAgents.get(deps.runtime)
  if (!active) {
    active = new Set<BotAgent>()
    warmingCatalogAgents.set(deps.runtime, active)
  }
  if (active.has(agent)) {
    return
  }
  active.add(agent)
  void catalog
    .demand({ agent })
    .then(async () => {
      const next = await catalog.read({ agent, waitForListing: false })
      if (catalogChoicesKey(next) !== catalogChoicesKey(previous)) {
        deps.onCatalogWarmed?.()
      }
    })
    .catch(() => {})
    .finally(() => {
      active.delete(agent)
    })
}

function catalogChoicesKey(result: AgentSessionModelCatalogResult | null): string {
  return JSON.stringify([
    Boolean(result?.unavailable),
    result && result.origin !== 'unknown' ? result.models : []
  ])
}

async function readAvailability(
  deps: BotBackupStatusReaderDeps,
  agent: BotAgent,
  model: string | undefined,
  available: ReadonlySet<BotAgent>
): Promise<{ state: BotBackupModelAvailability; resetsAt?: number }> {
  if (!available.has(agent)) {
    return { state: 'unavailable' }
  }
  const key = {
    agent,
    accountHomeKey: await deps.resolveAccountHomeKey(agent),
    model: model ?? ''
  }
  if (deps.gate.isLimited(key)) {
    const resetsAt = deps.gate.limitResetAt(key)
    return { state: 'at-limit', ...(resetsAt !== undefined ? { resetsAt } : {}) }
  }
  return { state: 'ready' }
}

/** Reads primary, configured backups, active failover state, and addable models (no secrets/paths). */
export async function readBotBackupStatus(
  deps: BotBackupStatusReaderDeps,
  botId: string
): Promise<BotBackupStatusResult> {
  const bot = deps.runtime.bots.list().find((entry) => entry.id === botId)
  if (!bot) {
    throw new Error('bot_not_found')
  }
  const available = await deps.availableAgents()
  const primaryTarget = botPrimaryTarget(bot)
  const primaryStatus = await readAvailability(
    deps,
    primaryTarget.agent,
    primaryTarget.model,
    available
  )
  const entries = await Promise.all(
    (bot.backupModels?.order ?? []).map(async (entry) => ({
      entry,
      ...(await readAvailability(deps, entry.agent, entry.model, available))
    }))
  )

  const availableOptions: BotBackupCatalogOption[] = []
  const catalog = await deps.runtime.structuredAgentModelCatalog().catch(() => null)
  if (catalog) {
    // List other installed agents ahead of the primary agent so cross-agent failovers appear first.
    const orderedAgents = [...available].sort((a, b) =>
      a === primaryTarget.agent ? 1 : b === primaryTarget.agent ? -1 : a.localeCompare(b)
    )
    const perAgent = await Promise.all(
      orderedAgents.map(async (agent): Promise<BotBackupCatalogOption[]> => {
        if (!isTuiAgent(agent)) {
          return []
        }
        const result = await catalog.read({ agent, waitForListing: false }).catch(() => null)
        if (result?.unavailable) {
          return []
        }
        const models = result
          ? agentPickerModels(
              {
                agent,
                catalog: keptSetupCatalog(agent, result),
                defaultSurface: 'chat',
                coherentCatalog: true
              },
              'chat'
            ).filter((model) => !model.hidden)
          : []
        if (models.length === 0) {
          // Always offer installed agents via their default model while warming their live catalog.
          demandCatalogOnce(deps, catalog, agent, result)
          const status = await readAvailability(deps, agent, undefined, available)
          return [{ agent, label: 'Default', ...status }]
        }
        if (result?.listingInProgress) {
          demandCatalogOnce(deps, catalog, agent, result)
        }
        return Promise.all(
          models.map(async (model) => {
            const status = await readAvailability(deps, agent, model.id, available)
            const efforts = structuredModelEfforts(model).map(({ value, label }) => ({
              value,
              label
            }))
            return {
              agent,
              model: model.id,
              label: model.label,
              ...(efforts.length > 0 ? { efforts } : {}),
              ...(model.defaultEffort ? { defaultEffort: model.defaultEffort } : {}),
              ...status
            }
          })
        )
      })
    )
    for (const group of perAgent) {
      availableOptions.push(...group)
    }
  }

  return {
    botId: bot.id,
    primary: {
      agent: primaryTarget.agent,
      ...(primaryTarget.model ? { model: primaryTarget.model } : {}),
      ...primaryStatus
    },
    backupModels: bot.backupModels ?? null,
    activeBackup: bot.activeBackup ?? null,
    entries,
    availableOptions
  }
}

/** Re-arms primary return checks for bots that were running on an active backup before restart. */
export function checkStartupBackupReturns(
  bots: readonly Bot[],
  deps: {
    gate: BotUsageLimitGate
    failover: BotUsageLimitFailover
    resolveAccountHomeKey: (agent: BotAgent, sessionId?: string) => Promise<string>
  }
): void {
  for (const bot of bots) {
    if (!bot.activeBackup) {
      continue
    }
    const primaryModel = bot.launch?.model ?? bot.activeBackup.primaryModel ?? ''
    const resetsAt = bot.activeBackup.primaryResetsAt
    void deps.resolveAccountHomeKey(bot.agent).then((accountHomeKey) => {
      if (resetsAt !== undefined && resetsAt > Date.now()) {
        deps.gate.recordLimit({ agent: bot.agent, accountHomeKey, model: primaryModel, resetsAt })
      } else {
        void deps.failover.returnToPrimary(bot.id).catch(() => {})
      }
    })
  }
}

/** Builds the StructuredAgentSessionHost hook connecting usage-limit cuts to bot failover. */
export function createBotBackupFailoverHostHook(
  ensureFailover: () => RuntimeBotBackupFailover,
  peekFailover: () => RuntimeBotBackupFailover | null
): StructuredAgentSessionBotBackupHook {
  return {
    onCutObserved: (sessionId, cut) => {
      void ensureFailover()
        .failover.onUsageLimitCut(sessionId, cut)
        .catch(() => {})
    },
    readCutState: (sessionId, turnItemId) => {
      const state = peekFailover()?.failover.readCutBackupState(sessionId, turnItemId)
      return state
        ? {
            backupState: state.backupState,
            ...(state.backupResetsAt !== undefined ? { backupResetsAt: state.backupResetsAt } : {})
          }
        : undefined
    },
    isSwitching: (sessionId, turnItemId) =>
      peekFailover()?.failover.isFailoverSwitching(sessionId, turnItemId) === true
  }
}

type BotBackupFailoverHostOwner = Pick<OrcaRuntimeService, 'requireStore'>

const registeredHostHooks = new WeakMap<
  BotBackupFailoverHostOwner,
  StructuredAgentSessionBotBackupHook
>()

export function registerBotBackupFailoverHostHook(runtime: OrcaRuntimeService): void {
  registeredHostHooks.set(
    runtime,
    createBotBackupFailoverHostHook(
      () => runtimeBotBackupFailover(runtime),
      () => peekRuntimeBotBackupFailover(runtime)
    )
  )
}

export function getRegisteredBotBackupFailoverHostHook(
  runtime: BotBackupFailoverHostOwner
): StructuredAgentSessionBotBackupHook | undefined {
  return registeredHostHooks.get(runtime)
}

/** Resolves the effective bot setup (primary or active/pre-routed backup) when starting a session. */
export async function resolveLaunchBotForStart(
  runtime: OrcaRuntimeService,
  bot: Bot,
  skipBackupResolve?: true
): Promise<Bot> {
  if (skipBackupResolve) {
    return bot
  }
  const setup = await runtimeBotBackupFailover(runtime)
    .failover.resolveLaunchSetup(bot)
    .catch(() => effectiveBotSetup(bot))
  if (setup.agent === bot.agent && setup.launch === bot.launch) {
    return bot
  }
  return botOnSetup(bot, { agent: setup.agent, ...(setup.launch ? { launch: setup.launch } : {}) })
}
