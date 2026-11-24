// CLI commands for managing a bot's backup models (`orca bot backup ...`).
import { isBotAgent } from '../../shared/bot-types'
import {
  addBotBackupModel,
  botPrimaryTarget,
  removeBotBackupModel,
  reorderBotBackupModels,
  type BotBackupModelEntry,
  type BotBackupStatusResult
} from '../../shared/bots/bot-backup-models'
import { formatUsageLimitResetClock } from '../../shared/agent-session/failures/agent-session-usage-limit'
import type { CommandHandler } from '../dispatch/dispatch'
import { getOptionalStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { callBots, findBot } from './bot'

function requireBotFlag(flags: Map<string, string | boolean>): string {
  const selector = getOptionalStringFlag(flags, 'bot')
  if (!selector) {
    throw new RuntimeClientError('invalid_argument', 'Missing --bot <name|id>')
  }
  return selector
}

function parsePositiveIndex(value: string | undefined, flagName: string): number {
  if (!value || !/^[1-9]\d*$/.test(value)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Invalid ${flagName}: expected a 1-based integer.`
    )
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Invalid ${flagName}: expected a 1-based integer.`
    )
  }
  return parsed - 1
}

function formatEntry(entry: BotBackupModelEntry): string {
  const effort = entry.options?.effort ? ` (${entry.options.effort})` : ''
  return `${entry.agent}${entry.model ? ` / ${entry.model}` : ' / default'}${effort}`
}

function formatStatus(status: BotBackupStatusResult): string {
  const lines: string[] = []
  const primaryModel = status.primary.model ?? 'default'
  const primaryState =
    status.primary.state === 'at-limit'
      ? status.primary.resetsAt
        ? `at limit, resets ${formatUsageLimitResetClock(status.primary.resetsAt)}`
        : 'at limit'
      : status.primary.state
  lines.push(`Primary: ${status.primary.agent} / ${primaryModel} (${primaryState})`)
  if (status.activeBackup) {
    lines.push(`Active backup: ${formatEntry(status.activeBackup.target)}`)
  }
  const mode = status.backupModels ? (status.backupModels.automatic ? 'auto' : 'ask') : 'off'
  lines.push(`Mode: ${mode}`)
  if (status.entries.length === 0) {
    lines.push('Backups: none')
  } else {
    lines.push('Backups:')
    status.entries.forEach((item, index) => {
      const state =
        item.state === 'at-limit'
          ? item.resetsAt
            ? `at limit, resets ${formatUsageLimitResetClock(item.resetsAt)}`
            : 'at limit'
          : item.state
      lines.push(`  ${index + 1}. ${formatEntry(item.entry)} [${state}]`)
    })
  }
  return lines.join('\n')
}

export const BOT_BACKUP_HANDLERS: Record<string, CommandHandler> = {
  'bot backup list': async ({ flags, client, json }) => {
    const bot = await findBot(client, requireBotFlag(flags))
    const result = await callBots<BotBackupStatusResult>(client, 'bots.backup.status', {
      botId: bot.id
    })
    printResult(result, json, formatStatus)
  },
  'bot backup add': async ({ flags, client, json }) => {
    const bot = await findBot(client, requireBotFlag(flags))
    const agent = getOptionalStringFlag(flags, 'agent')
    if (!agent || !isBotAgent(agent)) {
      throw new RuntimeClientError('invalid_argument', 'Missing or unknown --agent <agent>')
    }
    const model = getOptionalStringFlag(flags, 'model')
    const effort = getOptionalStringFlag(flags, 'effort')
    const entry: BotBackupModelEntry = {
      agent,
      ...(model ? { model } : {}),
      ...(effort ? { options: { effort } } : {})
    }
    const next = addBotBackupModel(bot.backupModels, entry, botPrimaryTarget(bot))
    const result = await callBots(client, 'bots.update', {
      botId: bot.id,
      updates: { backupModels: next ?? null }
    })
    printResult(result, json, () => `Added backup model: ${formatEntry(entry)}`)
  },
  'bot backup remove': async ({ flags, client, json }) => {
    const bot = await findBot(client, requireBotFlag(flags))
    const index = parsePositiveIndex(getOptionalStringFlag(flags, 'index'), '--index')
    const next = removeBotBackupModel(bot.backupModels, index)
    const result = await callBots(client, 'bots.update', {
      botId: bot.id,
      updates: { backupModels: next ?? null }
    })
    printResult(result, json, () => `Removed backup model #${index + 1}.`)
  },
  'bot backup reorder': async ({ flags, client, json }) => {
    const bot = await findBot(client, requireBotFlag(flags))
    const from = parsePositiveIndex(getOptionalStringFlag(flags, 'from'), '--from')
    const to = parsePositiveIndex(getOptionalStringFlag(flags, 'to'), '--to')
    const next = reorderBotBackupModels(bot.backupModels, from, to)
    const result = await callBots(client, 'bots.update', {
      botId: bot.id,
      updates: { backupModels: next ?? null }
    })
    printResult(result, json, () => `Moved backup model #${from + 1} to #${to + 1}.`)
  },
  'bot backup mode': async ({ flags, client, json }) => {
    const bot = await findBot(client, requireBotFlag(flags))
    const auto = flags.has('auto')
    const ask = flags.has('ask')
    if (auto === ask) {
      throw new RuntimeClientError('invalid_argument', 'Specify exactly one of --auto or --ask.')
    }
    if (!bot.backupModels || bot.backupModels.order.length === 0) {
      throw new RuntimeClientError('invalid_argument', 'Add at least one backup model first.')
    }
    const result = await callBots(client, 'bots.update', {
      botId: bot.id,
      updates: { backupModels: { ...bot.backupModels, automatic: auto } }
    })
    printResult(result, json, () =>
      auto
        ? 'Backup failover mode set to automatic.'
        : 'Backup failover mode set to ask before switching.'
    )
  },
  'bot backup clear': async ({ flags, client, json }) => {
    const bot = await findBot(client, requireBotFlag(flags))
    const result = await callBots(client, 'bots.update', {
      botId: bot.id,
      updates: { backupModels: null }
    })
    printResult(result, json, () => 'Cleared all backup models.')
  },
  'bot backup return': async ({ flags, client, json }) => {
    const bot = await findBot(client, requireBotFlag(flags))
    const result = await callBots<{ returned: boolean }>(client, 'bots.backup.return', {
      botId: bot.id
    })
    printResult(result, json, (value) =>
      value.returned
        ? 'Returned bot to its primary model.'
        : 'Bot is already running on its primary model.'
    )
  }
}
