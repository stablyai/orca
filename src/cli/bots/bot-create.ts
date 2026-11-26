// `orca bot create --offer`: shows the owner a card proposing a new bot, which creates nothing until
// they press Create bot. Creating a bot is the owner's, in Orca.
import { readInjectedAgentSessionId } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { BOT_TEMPLATES, botTemplate } from '../../shared/bots/bot-templates'
import type { HandedWorkspace } from '../../shared/bots/bot-made-for-workspaces'
import type {
  RuntimeWorktreePsSummary,
  RuntimeWorktreeRecord
} from '../../shared/worktree/catalog/runtime-worktree-contracts'
import type { CommandHandler } from '../dispatch/dispatch'
import {
  getOptionalStringFlag,
  getRepeatedStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import type { RuntimeClient } from '../runtime/client'
import { callBots } from './bot'
import { WORKTREE_PS_SINCE_READ_LIMIT } from '../workspaces/worktree-ps-recent'
import { readWorktreePsAcrossServers } from '../workspaces/worktree-ps-fleet'

/** The listed row a selector names, when exactly one does. */
function rowFor(
  rows: RuntimeWorktreePsSummary[],
  selector: string
): RuntimeWorktreePsSummary | undefined {
  const value = selector.replace(/^(id|name):/, '')
  const matches = rows.filter((row) =>
    selector.startsWith('id:')
      ? row.worktreeId === value
      : selector.startsWith('name:')
        ? row.displayName === value
        : row.worktreeId === value || row.displayName === value
  )
  return matches.length === 1 ? matches[0] : undefined
}

async function worktreesOf(client: RuntimeClient, selectors: string[]): Promise<HandedWorkspace[]> {
  if (selectors.length === 0) {
    return []
  }
  // Listed rows cover paired servers too; anything else is resolved here.
  const rows = (await readWorktreePsAcrossServers(client, { limit: WORKTREE_PS_SINCE_READ_LIMIT }))
    .result.worktrees
  const found: HandedWorkspace[] = []
  for (const selector of selectors) {
    const row = rowFor(rows, selector)
    const record = row
      ? { id: row.worktreeId, displayName: row.displayName }
      : (
          await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
            worktree: selector
          })
        ).result.worktree
    if (!found.some((entry) => entry.id === String(record.id))) {
      found.push({ id: String(record.id), name: String(record.displayName || selector) })
    }
  }
  return found
}

async function offer({ flags, client, json }: Parameters<CommandHandler>[0]): Promise<void> {
  const callerSessionId = readInjectedAgentSessionId()
  if (!callerSessionId) {
    throw new RuntimeClientError('invalid_argument', "Run this from a bot's chat.")
  }
  const templateId = getOptionalStringFlag(flags, 'template')
  const template = templateId === undefined ? null : botTemplate(templateId)
  if (templateId !== undefined && !template) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--template is one of: ${BOT_TEMPLATES.map((entry) => entry.id).join(', ')}`
    )
  }
  const purpose = getOptionalStringFlag(flags, 'purpose') ?? template?.line
  if (!purpose) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--offer needs --purpose: what the bot is for, in one sentence.'
    )
  }
  const field = (name: 'watches' | 'does' | 'reports') =>
    getOptionalStringFlag(flags, name) ?? template?.[name]
  const worktrees = await worktreesOf(client, getRepeatedStringFlag(flags, 'worktree'))
  const watches = field('watches')
  const does = field('does')
  const reports = field('reports')
  const result = await callBots<{ offered: boolean; message: string }>(client, 'bots.createOffer', {
    callerSessionId,
    name:
      getOptionalStringFlag(flags, 'name') ??
      template?.name ??
      getRequiredStringFlag(flags, 'name'),
    purpose,
    ...(watches ? { watches } : {}),
    ...(does ? { does } : {}),
    ...(reports ? { reports } : {}),
    ...(template ? { templateId: template.id } : {}),
    ...(worktrees.length ? { worktrees } : {})
  })
  printResult(result, json, (value) => value.message)
}

export const BOT_CREATE_HANDLERS: Record<string, CommandHandler> = {
  'bot create': async (context) => {
    // Only the owner creates a bot, in Orca; from the CLI a bot can only propose one.
    if (!context.flags.has('offer')) {
      throw new RuntimeClientError(
        'invalid_argument',
        'A bot can’t create a bot. Propose one with --offer; your owner creates it from the card.'
      )
    }
    await offer(context)
  }
}
