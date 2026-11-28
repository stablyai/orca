// `orca bot create --offer`: shows the owner a card proposing a new bot, which creates nothing until
// they press Create bot. Without --offer, creates the bot directly when the local host opts in
// (desktop Settings › Bots or `orca serve --allow-cli-bot-create`).
import { readInjectedAgentSessionId } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { BOT_AGENTS, isBotAgent, type BotAgent } from '../../shared/bot-types'
import { proposalCreateParams, type BotProposal } from '../../shared/bots/bot-proposal'
import { BOT_TEMPLATES, botTemplate, type BotTemplate } from '../../shared/bots/bot-templates'
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

type ResolvedBotSpec = {
  name: string
  purpose: string
  watches?: string
  does?: string
  reports?: string
  template: BotTemplate | null
}

function resolveBotSpec(
  flags: Map<string, string | boolean>,
  options: { offer: boolean }
): ResolvedBotSpec {
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
      options.offer
        ? '--offer needs --purpose: what the bot is for, in one sentence.'
        : 'Missing required --purpose: what the bot is for, in one sentence (or pass --template).'
    )
  }
  const field = (name: 'watches' | 'does' | 'reports') =>
    getOptionalStringFlag(flags, name) ?? template?.[name]
  const watches = field('watches')
  const does = field('does')
  const reports = field('reports')
  return {
    name:
      getOptionalStringFlag(flags, 'name') ??
      template?.name ??
      getRequiredStringFlag(flags, 'name'),
    purpose,
    ...(watches ? { watches } : {}),
    ...(does ? { does } : {}),
    ...(reports ? { reports } : {}),
    template
  }
}

async function offer({ flags, client, json }: Parameters<CommandHandler>[0]): Promise<void> {
  if (getOptionalStringFlag(flags, 'agent') !== undefined) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--agent applies only when creating a bot directly without --offer.'
    )
  }
  const callerSessionId = readInjectedAgentSessionId()
  if (!callerSessionId) {
    throw new RuntimeClientError('invalid_argument', "Run this from a bot's chat.")
  }
  const { name, purpose, watches, does, reports, template } = resolveBotSpec(flags, { offer: true })
  const worktrees = await worktreesOf(client, getRepeatedStringFlag(flags, 'worktree'))
  const result = await callBots<{ offered: boolean; message: string }>(client, 'bots.createOffer', {
    callerSessionId,
    name,
    purpose,
    ...(watches ? { watches } : {}),
    ...(does ? { does } : {}),
    ...(reports ? { reports } : {}),
    ...(template ? { templateId: template.id } : {}),
    ...(worktrees.length ? { worktrees } : {})
  })
  printResult(result, json, (value) => value.message)
}

/** Without --offer: creates the bot outright. Only a host with local CLI bot creation enabled
 *  (desktop Settings › Bots or `orca serve --allow-cli-bot-create`) accepts it, and only from its
 *  own machine's CLI; anywhere else `bots.create` refuses with the propose-one message. */
async function create({ flags, client, json }: Parameters<CommandHandler>[0]): Promise<void> {
  if (client.isRemote) {
    throw new RuntimeClientError(
      'invalid_argument',
      "Direct `orca bot create` only runs against this machine's local Orca; a paired CLI cannot create bots directly. Use `--environment local` on that machine or propose one with `--offer`."
    )
  }
  const explicitAgent = getOptionalStringFlag(flags, 'agent')
  if (explicitAgent !== undefined && !isBotAgent(explicitAgent)) {
    throw new RuntimeClientError('invalid_argument', `--agent is one of: ${BOT_AGENTS.join(', ')}`)
  }
  const { name, purpose, watches, does, reports, template } = resolveBotSpec(flags, {
    offer: false
  })
  const worktrees = await worktreesOf(client, getRepeatedStringFlag(flags, 'worktree'))
  const agent: BotAgent =
    explicitAgent ??
    (await callBots<{ defaultAgent: BotAgent }>(client, 'bots.agentChoices')).result.defaultAgent
  const proposal: BotProposal = {
    name,
    purpose,
    ...(watches ? { watches } : {}),
    ...(does ? { does } : {}),
    ...(reports ? { reports } : {}),
    ...(template ? { templateId: template.id, mascot: template.mascot } : {}),
    ...(worktrees.length ? { worktrees } : {})
  }
  const result = await callBots<{ bot: { id: string; name: string; folder: string } }>(
    client,
    'bots.create',
    proposalCreateParams(proposal, agent, { templatePackages: true })
  )
  printResult(result, json, ({ bot }) => `Created ${bot.name} (${bot.id}) in ${bot.folder}`)
}

export const BOT_CREATE_HANDLERS: Record<string, CommandHandler> = {
  'bot create': async (context) => {
    // A bot only proposes one (--offer); the owner creates it in Orca, or this machine's own CLI
    // does when enabled via Settings › Bots or `orca serve --allow-cli-bot-create`.
    await (context.flags.has('offer') ? offer(context) : create(context))
  }
}
