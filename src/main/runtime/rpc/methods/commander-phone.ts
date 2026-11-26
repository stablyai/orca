import { humanRecurringAnswer } from '../../../../shared/commander/recurring-answer'
import type { CommanderMemoryRevision } from '../../../../shared/commander/memory-contract'
import { defineMethod, type RpcContext } from '../core'
import { isHostOwnPhone } from '../callers/host-own-phone'
import {
  commanderMemoryService,
  recurringAnswersSetting,
  saveCommanderMemory
} from '../../../commander/commander-memory-service'
import { phoneMemoryStatus, requirePhoneMemory } from '../../../commander/commander-phone-access'
import {
  CommanderPhoneListParams,
  CommanderPhoneRecurringAnswersParams,
  CommanderPhoneReadParams,
  CommanderPhoneSaveParams,
  commanderPhoneSummary
} from '../../../../shared/rpc-contract/commander-phone-params'

function requirePairedPhone(ctx: RpcContext) {
  if (
    !isHostOwnPhone(ctx) ||
    !ctx.pairedDeviceId ||
    ctx.caller?.kind !== 'paired-device' ||
    ctx.caller.deviceId !== ctx.pairedDeviceId ||
    ctx.caller.agent
  ) {
    throw new Error('A directly paired phone is required.')
  }
}

function summarizePage(page: CommanderMemoryRevision) {
  const recurringQuestion = humanRecurringAnswer(page)?.question
  return commanderPhoneSummary.parse({ ...page, recurringQuestion })
}

export const COMMANDER_PHONE_METHODS = [
  defineMethod({
    name: 'commanderPhone.recurringAnswers',
    permission: 'workspace',
    params: CommanderPhoneRecurringAnswersParams,
    handler: async ({ account, change }, ctx) => {
      requirePairedPhone(ctx)
      const checkSharing = () => requirePhoneMemory(account)
      await checkSharing()
      const setting = await recurringAnswersSetting(account, change, checkSharing)
      await checkSharing()
      return setting
    }
  }),
  defineMethod({
    name: 'commanderPhone.status',
    permission: 'workspace',
    params: null,
    handler: async (_params, ctx) => {
      requirePairedPhone(ctx)
      return phoneMemoryStatus()
    }
  }),
  defineMethod({
    name: 'commanderPhone.list',
    permission: 'workspace',
    params: CommanderPhoneListParams,
    handler: async ({ account, after, projectId, includeDeleted, handoffsOnly, q, order }, ctx) => {
      requirePairedPhone(ctx)
      const checkSharing = () => requirePhoneMemory(account)
      await checkSharing()
      const index = await commanderMemoryService.index(
        account,
        {
          order: order ?? 'id',
          after,
          projectId: projectId || undefined,
          includeDeleted,
          handoffsOnly,
          ...(handoffsOnly && order === 'recent' ? { validHandoffsOnly: true } : {}),
          q
        },
        checkSharing
      )
      await checkSharing()
      const registered = ctx.runtime.listVisibleProjectHostSetups().map((s) => s.projectId)
      return {
        pages: index.pages.map((page) => commanderPhoneSummary.parse(page)),
        projects: [...new Set([...registered, ...index.projects])].sort(),
        next: index.next
      }
    }
  }),
  defineMethod({
    name: 'commanderPhone.read',
    permission: 'workspace',
    params: CommanderPhoneReadParams,
    handler: async ({ account, pageId, beforeVersion, version }, ctx) => {
      requirePairedPhone(ctx)
      await requirePhoneMemory(account)
      const result = await commanderMemoryService.get(
        account,
        pageId,
        version === undefined ? beforeVersion : version + 1
      )
      await requirePhoneMemory(account)
      const selectedRevision =
        version === undefined
          ? undefined
          : result.history.find((revision) => revision.version === version)
      if (version !== undefined && !selectedRevision) {
        throw new Error('Memory revision was not found.')
      }
      return {
        page: result.page,
        selectedRevision,
        history: result.history.map(summarizePage),
        nextBeforeVersion: result.nextBeforeVersion ?? null
      }
    }
  }),
  defineMethod({
    name: 'commanderPhone.save',
    permission: 'workspace',
    params: CommanderPhoneSaveParams,
    handler: async ({ account, write }, ctx) => {
      requirePairedPhone(ctx)
      await requirePhoneMemory(account)
      const result = await saveCommanderMemory(account, write, () => requirePhoneMemory(account))
      await requirePhoneMemory(account)
      return result
    }
  })
]
