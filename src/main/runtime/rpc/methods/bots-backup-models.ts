import {
  BotBackupReturnParamsSchema,
  BotBackupStatusParamsSchema,
  BotBackupSwitchParamsSchema
} from '../../../../shared/bots/bot-backup-models'
import { runtimeBotBackupFailover } from '../../../bots/bot-usage-limit-failover-runtime'
import { defineMethod } from '../core'
import { ownerOnly } from './bots-caller-gates'

export const BOT_BACKUP_STATUS_METHOD = defineMethod({
  name: 'bots.backup.status',
  permission: 'workspace',
  params: BotBackupStatusParamsSchema,
  handler: async (params, { runtime }) => runtimeBotBackupFailover(runtime).readStatus(params.botId)
})

export const BOT_BACKUP_SWITCH_METHOD = defineMethod({
  name: 'bots.backup.switch',
  permission: 'workspace',
  params: BotBackupSwitchParamsSchema,
  handler: async (params, context) => {
    ownerOnly(context, 'Only the owner can switch a bot to a backup model.')
    return runtimeBotBackupFailover(context.runtime).failover.switchSessionManually(params)
  }
})

export const BOT_BACKUP_RETURN_METHOD = defineMethod({
  name: 'bots.backup.return',
  permission: 'workspace',
  params: BotBackupReturnParamsSchema,
  handler: async (params, context) => {
    ownerOnly(context, 'Only the owner can return a bot to its primary model.')
    const returned = await runtimeBotBackupFailover(context.runtime).failover.returnToPrimary(
      params.botId,
      { force: true }
    )
    return { returned }
  }
})

export const BOT_BACKUP_MODEL_METHODS = [
  BOT_BACKUP_STATUS_METHOD,
  BOT_BACKUP_SWITCH_METHOD,
  BOT_BACKUP_RETURN_METHOD
]
