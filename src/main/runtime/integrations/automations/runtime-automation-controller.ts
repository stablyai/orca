import { hostQualifiedRepoSelector } from '../../workspaces/catalog/runtime-repo-selector'
import { parseExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { AutomationService } from '../../../automations/automation-service'
import type {
  Automation,
  AutomationUpdateInput
} from '../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { AutomationRunEvent } from '../../../../shared/automation-event-triggers'
import { AutomationWebhookSaves } from '../../../webhooks/automation-webhook-saves'
import type {
  AutomationListParams,
  AutomationListResult
} from '../../../../shared/automations/ownership/automation-list-scope'
import type {
  AutomationOwnerFenceOperation,
  AutomationOwnerPrecondition,
  AutomationDestination,
  AutomationUpdatePreconditions
} from '../../../../shared/automations/ownership/automation-owner-precondition'
import { runAutomationNowFenced } from '../../../automations/dispatch/refused-manual-run'
import type { EventRunOptions } from '../../../automations/automation-trigger-runs'
import { paginateAutomationRuns } from '../../../../shared/automations/history/automation-run-cursor'
import {
  copyRuntimeAutomationPatchValues,
  hasRuntimeAutomationUpdateValue
} from './runtime-automation-update-value'
import {
  updateRuntimeAutomations,
  type RuntimeAutomationBatchUpdate
} from './runtime-automation-batch-update'
import {
  assertAutomationRunContextMatchesTarget,
  type RuntimeAutomationCreateInput,
  type RuntimeAutomationUpdateInput
} from './runtime-automation-run-context'
import type { ConnectorRefResolver } from '../../../connector-cloud/connector-ref-resolution'
import { assertBotPlacesUnchanged } from '../../../automations/bot-automation-place-refs'
import type { Bot } from '../../../../shared/bot-types'
import type { TriggerPeopleSearch } from '../../../automations/bot-trigger-people'
import { botAutomationCreateRules, patchBotAutomationUpdate } from './runtime-automation-bot-update'
import {
  assertAutomationBotAtWrite,
  botAutomationAgent,
  botAutomationTarget,
  requireCreatableAutomationBot,
  assertThreadReplies,
  resolveRuntimeAutomationTarget,
  type BotChatLookup,
  type RuntimeAutomationTargetResolvers
} from './runtime-automation-target'

export class RuntimeAutomationController {
  private service: AutomationService | null = null
  /** Set once this host can make webhooks. */
  readonly webhooks = new AutomationWebhookSaves()

  /** Whether this host's Orca Cloud binds an event run to its thread; set with the connector. */
  takesThreadReplies: () => boolean = () => false
  /** Looks places up as refs where this host's Orca Cloud takes them; set with the connector. */
  placeRefs: () => ConnectorRefResolver | null = () => null
  /** Who a rule's from= names, where this host's Orca Cloud takes it; set with the connector. */
  triggerPeople: (bot: Bot) => TriggerPeopleSearch | null = () => null
  /** Which rules this host's Orca Cloud takes (CloudTriggers); set with the connector. */
  cloudTriggers = () => ({ own: false, github2: false, workflows: false, ciFinished: false })
  /** A bot's chat a run may continue; set with the runtime, which reads its chats. */
  botChat: BotChatLookup = async () => null

  constructor(
    private readonly store: RuntimeStore | null,
    private readonly resolvers: RuntimeAutomationTargetResolvers
  ) {}

  setService(service: AutomationService): void {
    this.service = service
  }

  /** Completed automation run terminals no client used, closed before an update; 0 off-headless. */
  releaseFinishedRunTerminals(): Promise<number> {
    return this.service?.runTerminalRetention?.drain() ?? Promise.resolve(0)
  }

  /** Keep runtime-owned automation work ahead of queued external probes. */
  withExternalProbePriority<T>(run: () => T): T {
    const wrap = this.service?.externalProbePriority
    return wrap ? wrap(run) : run()
  }

  list(): Automation[] {
    if (!this.store?.listAutomations) {
      throw new Error('runtime_unavailable')
    }
    return this.store.listAutomations()
  }

  listRuns(automationId?: string): AutomationRun[] {
    if (!this.store?.listAutomationRuns) {
      throw new Error('runtime_unavailable')
    }
    return this.store.listAutomationRuns(automationId)
  }

  listRunsByAutomation(automationIds: readonly string[]): Map<string, AutomationRun[]> {
    if (!this.store?.listAutomationRunsByAutomation) {
      throw new Error('runtime_unavailable')
    }
    return this.store.listAutomationRunsByAutomation(automationIds)
  }

  listRunsPage(automationId?: string, limit?: number, cursor?: string) {
    if (this.store?.listAutomationRunsPage) {
      return this.store.listAutomationRunsPage(automationId, limit, cursor)
    }
    return paginateAutomationRuns(this.listRuns(automationId), limit, cursor)
  }

  listForScope(params: AutomationListParams = {}): AutomationListResult {
    if (!this.store?.listAutomationsForScope) {
      throw new Error('runtime_unavailable')
    }
    return this.store.listAutomationsForScope(params)
  }

  ownerPrecondition(id: string): AutomationOwnerPrecondition | null {
    return this.store?.automationOwnerPrecondition?.(id) ?? null
  }

  show(id: string): Automation {
    const automation = this.list().find((entry) => entry.id === id)
    if (!automation) {
      throw new Error('Automation not found.')
    }
    return automation
  }

  async create(
    input: RuntimeAutomationCreateInput,
    destination?: AutomationDestination,
    /** Runs after the target resolves, right before the write; a throw refuses it (a plugin
     *  creator that lost its approval meanwhile). */
    beforeWrite?: () => void
  ): Promise<Automation> {
    const store = this.store
    if (!store?.createAutomation) {
      throw new Error('runtime_unavailable')
    }
    const createAutomation = store.createAutomation.bind(store)
    const bot = requireCreatableAutomationBot(store, input, this.webhooks)
    assertThreadReplies(this.takesThreadReplies, input.bot)
    const target = bot
      ? botAutomationTarget(bot)
      : await resolveRuntimeAutomationTarget(this.resolvers, input)
    beforeWrite?.()
    assertAutomationRunContextMatchesTarget(input.runContext, target.repo)
    if (input.reuseSession && target.workspaceMode !== 'existing') {
      throw new Error('Session reuse requires an existing workspace target.')
    }
    const { on: rules, bot: botTarget } = await botAutomationCreateRules(this, bot, input)
    const chosen = destination ?? input.destination
    return await this.webhooks.save(bot && { botId: bot.id }, rules, async (on, id) => {
      assertAutomationBotAtWrite(store, botTarget)
      const automation = createAutomation(
        {
          creationKey: input.creationKey,
          name: input.name,
          prompt: input.prompt,
          precheck: input.precheck,
          agentId: bot ? botAutomationAgent(botTarget, bot) : input.agentId,
          updateCodexBeforeRun: input.updateCodexBeforeRun,
          extraAgentArgs: input.extraAgentArgs,
          launchSetupPatch: input.launchSetupPatch,
          runContext: input.runContext,
          sourceContext: input.sourceContext,
          ...(botTarget ? { bot: botTarget } : {}),
          ...(on ? { on } : {}),
          ...(input.once ? { once: input.once } : {}),
          projectId: target.projectId,
          workspaceMode: target.workspaceMode,
          workspaceId: target.workspaceId,
          baseBranch: input.baseBranch,
          setupDecision: input.setupDecision,
          setupTrustHash: input.setupTrustHash,
          reuseSession: input.reuseSession,
          timezone: input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
          timezoneExplicit: input.timezoneExplicit,
          rrule: input.rrule,
          dtstart: input.dtstart,
          enabled: input.enabled,
          missedRunGraceMinutes: input.missedRunGraceMinutes,
          createdBy: input.createdBy
        },
        { destination: chosen, id, resolvedRepo: target.repo ?? undefined }
      )
      await store.flushPendingOrThrowAsync?.({ drainToStableGeneration: false })
      return automation
    })
  }

  async update(
    id: string,
    updates: RuntimeAutomationUpdateInput,
    options?: AutomationUpdatePreconditions
  ): Promise<Automation> {
    const store = this.store
    if (!store?.updateAutomation) {
      throw new Error('runtime_unavailable')
    }
    const updateAutomation = store.updateAutomation.bind(store)
    const current = this.show(id)
    const patch: AutomationUpdateInput = {}
    copyRuntimeAutomationPatchValues(updates, patch)
    const targetChanged =
      hasRuntimeAutomationUpdateValue(updates, 'repo') ||
      hasRuntimeAutomationUpdateValue(updates, 'workspace') ||
      hasRuntimeAutomationUpdateValue(updates, 'workspaceMode')
    const botChanged = hasRuntimeAutomationUpdateValue(updates, 'bot')
    if (current.bot ? targetChanged : botChanged) {
      throw new Error('An automation cannot move between a bot and a project.')
    }
    assertThreadReplies(this.takesThreadReplies, updates.bot, current)
    if (current.bot) {
      await patchBotAutomationUpdate(this, store, { ...current, bot: current.bot }, updates, patch)
    }
    let resolvedRepo: Repo | undefined
    if (targetChanged) {
      const target = await resolveRuntimeAutomationTarget(this.resolvers, updates, current)
      resolvedRepo = target.repo ?? undefined
      assertAutomationRunContextMatchesTarget(updates.runContext, target.repo)
      if (patch.reuseSession === true && target.workspaceMode !== 'existing') {
        throw new Error('Session reuse requires an existing workspace target.')
      }
      patch.projectId = target.projectId
      patch.workspaceMode = target.workspaceMode
      patch.workspaceId = target.workspaceId
      if (target.workspaceMode !== 'existing') {
        patch.reuseSession = false
      }
    }
    if (
      !targetChanged &&
      hasRuntimeAutomationUpdateValue(updates, 'runContext') &&
      current.projectId
    ) {
      const host = parseExecutionHostId(updates.runContext?.hostId ?? current.runContext?.hostId)
      const repo = await this.resolvers.showRepo(
        hostQualifiedRepoSelector(
          `id:${current.projectId}`,
          host?.kind === 'runtime' ? 'local' : host?.id
        )
      )
      assertAutomationRunContextMatchesTarget(updates.runContext, repo)
    }
    if (!targetChanged && patch.reuseSession && current.workspaceMode !== 'existing') {
      throw new Error('Session reuse requires an existing workspace target.')
    }
    const owner = current.bot ? { botId: current.bot.botId, current } : null
    return await this.webhooks.save(owner, patch.on, async (on) => {
      // Checked with the write, so a pass that read it earlier never overwrites a newer edit.
      assertBotPlacesUnchanged(this.show(id), options?.unchangedSince)
      assertAutomationBotAtWrite(store, updates.bot)
      const automation = updateAutomation(id, on ? { ...patch, on } : patch, {
        ...options,
        resolvedRepo
      })
      await store.flushPendingOrThrowAsync?.({ drainToStableGeneration: false })
      return automation
    })
  }

  /** `update` for many automations with one store write and one flush; moves need `update`. */
  updateMany(entries: readonly RuntimeAutomationBatchUpdate[]) {
    return updateRuntimeAutomations(this.store, entries)
  }

  async delete(
    id: string,
    expectedOwner?: AutomationOwnerPrecondition
  ): Promise<{ removed: boolean; id: string }> {
    if (!this.store?.deleteAutomation) {
      throw new Error('runtime_unavailable')
    }
    this.show(id)
    this.store.deleteAutomation(id, expectedOwner ? { expectedOwner } : undefined)
    await this.store.flushPendingOrThrowAsync?.({ drainToStableGeneration: false })
    return { removed: true, id }
  }

  async runNow(id: string, expectedOwner?: AutomationOwnerPrecondition): Promise<AutomationRun> {
    if (!this.service) {
      throw new Error('runtime_unavailable')
    }
    return await runAutomationNowFenced({
      automationId: id,
      service: this.service,
      fence: () => this.assertOwner(id, expectedOwner, 'execute')
    })
  }

  async runForEvent(id: string, event: AutomationRunEvent, gate?: EventRunOptions) {
    if (!this.service) {
      throw new Error('runtime_unavailable')
    }
    return await this.service.runForEvent(id, event, gate)
  }

  assertOwner(
    id: string,
    expectedOwner: AutomationOwnerPrecondition | undefined,
    operation: AutomationOwnerFenceOperation
  ): void {
    if (!this.store?.assertAutomationOwnerFence) {
      if (expectedOwner) {
        throw new Error('runtime_unavailable')
      }
      return
    }
    this.store.assertAutomationOwnerFence({ id, expectedOwner, operation })
  }
}
