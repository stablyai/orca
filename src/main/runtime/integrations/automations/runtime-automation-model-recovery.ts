import type { AutomationBotTarget } from '../../../../shared/automations/automation-definition'
import {
  automationModelRecoveryExecutionTarget,
  automationModelRecoverySetupFingerprint,
  automationModelRecoveryTarget,
  isReadableAutomationRecoveryModel,
  type AutomationModelRecoveryInput,
  type AutomationModelRecoveryProjection,
  type AutomationModelRecoveryResult,
  type AutomationModelRecoverySelection
} from '../../../../shared/automations/history/automation-model-recovery'
import { newChatPermissionModeForSettings } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { Bot } from '../../../../shared/bot-types'
import type { AutomationOwnerPrecondition } from '../../../../shared/automations/ownership/automation-owner-precondition'
import { isFailedAutomationRunModel } from '../../../../shared/automations/history/automation-run-model-failure'
import { BotLaunchSchema } from '../../../../shared/bots/bot-launch'
import { botAutomationSetup, botOnSetup } from '../../../../shared/bots/bot-agent-setup'
import { resolveBotAutomationRunTarget } from '../../../automations/bot-run-target'
import {
  botBackgroundStartOptions,
  botStartPermission,
  type BotLaunchSettings
} from '../../../bots/bot-start-options'
import type { AutomationService } from '../../../automations/automation-service'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { RuntimeAutomationController } from './runtime-automation-controller'

type RecoveryStore = Pick<
  RuntimeStore,
  'getFolderWorkspaces' | 'getBots' | 'updateAutomation' | 'flushPendingOrThrowAsync'
> & { getSettings: () => NonNullable<BotLaunchSettings> & { botsEnabled?: boolean } }

function automationRecoveryPermission(
  settings: BotLaunchSettings,
  bot: Pick<Bot, 'agent' | 'permissionMode'>
): AutomationModelRecoverySelection['permission'] {
  return botStartPermission(bot) ?? newChatPermissionModeForSettings(bot.agent, settings)
}

export function readAutomationRecoverySelection(
  store: Pick<RecoveryStore, 'getBots' | 'getSettings'>,
  target?: AutomationBotTarget
): AutomationModelRecoveryProjection | undefined {
  const bot =
    target?.runsIn === 'new' && store.getBots?.().find((entry) => entry.id === target.botId)
  if (!bot || !target) {
    return undefined
  }
  const settings = store.getSettings()
  const setup = botAutomationSetup(target, bot)
  const model = botBackgroundStartOptions(settings, setup).model ?? null
  if (!isReadableAutomationRecoveryModel(model)) {
    return undefined
  }
  return {
    setupFingerprint: automationModelRecoverySetupFingerprint(setup, bot),
    model,
    permission: automationRecoveryPermission(settings, {
      ...setup,
      permissionMode: bot.permissionMode
    })
  }
}

export async function recoverAutomationModel(
  pending: Set<string>,
  controller: Pick<RuntimeAutomationController, 'assertOwner' | 'show' | 'listRuns'>,
  store: RecoveryStore | null,
  service: Pick<AutomationService, 'runNow'> | null,
  { id, runId, expectedTarget, model }: AutomationModelRecoveryInput,
  expectedOwner?: AutomationOwnerPrecondition
): Promise<AutomationModelRecoveryResult> {
  if (pending.has(id)) {
    return { status: 'busy' }
  }
  pending.add(id)
  try {
    const getFolders = store?.getFolderWorkspaces?.bind(store)
    const flush = store?.flushPendingOrThrowAsync?.bind(store)
    if (!store?.updateAutomation || !getFolders || !flush || !service) {
      throw new Error('runtime_unavailable')
    }
    const resolve = (target: AutomationBotTarget) =>
      resolveBotAutomationRunTarget(
        {
          getSettings: () => store.getSettings(),
          getBots: () => store.getBots?.() ?? [],
          getFolderWorkspaces: getFolders
        },
        target
      )

    controller.assertOwner(id, expectedOwner, 'mutate')
    if (!model || !isReadableAutomationRecoveryModel(model)) {
      return { status: 'changed' }
    }
    const target = controller.show(id).bot
    const failed = controller.listRuns(id).find((run) => run.id === runId)
    if (
      target?.runsIn !== 'new' ||
      failed?.status !== 'dispatch_failed' ||
      failed.errorCode !== 'agentModelUnavailable' ||
      isFailedAutomationRunModel(model, failed.errorParams)
    ) {
      return { status: 'changed' }
    }
    const resolved = resolve(target)
    const settings = store.getSettings()
    if (!resolved.ok || failed.errorParams?.agent !== resolved.bot.agent) {
      return { status: 'changed' }
    }
    const permission = automationRecoveryPermission(settings, resolved.bot)
    if (
      automationModelRecoveryTarget(target, resolved.bot, resolved.cwd, permission) !==
      expectedTarget
    ) {
      return { status: 'changed' }
    }
    const { model: effectiveModel, ...options } = botBackgroundStartOptions(settings, resolved.bot)
    if (effectiveModel === model || !isReadableAutomationRecoveryModel(effectiveModel ?? null)) {
      return { status: 'changed' }
    }
    // An explicit Settings model owns its options. Options without a model can apply to the new choice.
    const keptOptions = effectiveModel
      ? resolved.bot.launch?.options
      : { ...options, ...resolved.bot.launch?.options }
    const launch = BotLaunchSchema.parse({
      model,
      ...(keptOptions && Object.keys(keptOptions).length > 0 ? { options: keptOptions } : {})
    })
    const bot = { ...target, agentSetup: { agent: resolved.bot.agent, launch } }
    const savedBot = botOnSetup(resolved.bot, bot.agentSetup)
    const { model: _savedModel, ...savedOptions } = botBackgroundStartOptions(settings, savedBot)
    const expectedSavedTarget = automationModelRecoveryExecutionTarget(
      bot,
      savedBot,
      resolved.cwd,
      permission
    )
    // Keep the read and write synchronous so the other bot settings come from the same record.
    store.updateAutomation(id, { bot, agentId: resolved.bot.agent }, { expectedOwner })
    try {
      await flush({ drainToStableGeneration: false })
    } catch {
      return { status: 'unconfirmed' }
    }

    let newerModel: boolean
    try {
      controller.assertOwner(id, expectedOwner, 'execute')
      const current = controller.show(id).bot
      if (!current || current.runsIn !== 'new') {
        return { status: 'saved', rerun: 'skipped' }
      }
      const runTarget = resolve(current)
      const currentSettings = store.getSettings()
      if (
        !runTarget.ok ||
        automationModelRecoveryExecutionTarget(
          current,
          runTarget.bot,
          runTarget.cwd,
          automationRecoveryPermission(currentSettings, runTarget.bot)
        ) !== expectedSavedTarget
      ) {
        return { status: 'saved', rerun: 'skipped' }
      }
      const { model: currentModel, ...currentOptions } = botBackgroundStartOptions(
        currentSettings,
        runTarget.bot
      )
      if (
        !currentModel ||
        !isReadableAutomationRecoveryModel(currentModel) ||
        // A concurrent edit can restore the failed model without changing any other setting.
        isFailedAutomationRunModel(currentModel, failed.errorParams) ||
        Object.keys(savedOptions).length !== Object.keys(currentOptions).length ||
        Object.entries(savedOptions).some(([key, value]) => currentOptions[key] !== value)
      ) {
        return { status: 'saved', rerun: 'skipped' }
      }
      newerModel = currentModel !== model
    } catch {
      return { status: 'saved', rerun: 'skipped' }
    }

    try {
      const run = await service.runNow(id)
      return { status: 'queued', runId: run.id, ...(newerModel ? { newerModel: true } : {}) }
    } catch {
      return { status: 'saved', rerun: 'unconfirmed' }
    }
  } finally {
    pending.delete(id)
  }
}
