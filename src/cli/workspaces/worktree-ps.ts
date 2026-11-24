// `orca worktree ps`: every workspace with its agents, or with --since only the recently active ones.
import type { RuntimeWorktreePsResult } from '../../shared/worktree/catalog/runtime-worktree-contracts'
import type { BotRosterEntry } from '../../shared/bot-roster'
import type { CommandHandler } from '../dispatch/dispatch'
import type { RuntimeClient } from '../runtime/client'
import { callerChat } from '../automations/automation-caller-chat'
import { getOptionalPositiveIntegerFlag } from '../arguments/flags'
import { formatWorktreePs } from './worktree-ps-format'
import { printResult } from '../output/command-result-output'
import {
  annotateOmittedHostScope,
  type WithAnnotatedHostScope
} from '../hosts/omitted-host-scope-selectors'
import { projectWorktreePsTerminalVerdict } from './worktree-ps-terminal-verdict'
import { readWorktreePsAcrossServers } from './worktree-ps-fleet'
import { annotatePsRows } from './worktree-address-annotation'
import {
  getOptionalDurationFlag,
  recentWorktreePs,
  WORKTREE_PS_SINCE_READ_LIMIT
} from './worktree-ps-recent'

export const runWorktreePs: CommandHandler = async ({ flags, client, json }) => {
  const since = getOptionalDurationFlag(flags, 'since')
  const limit = getOptionalPositiveIntegerFlag(flags, 'limit')
  const params = {
    // --since filters here, so it reads every row and caps after.
    limit: since === undefined ? limit : WORKTREE_PS_SINCE_READ_LIMIT,
    ...(json && flags.has('agent-wait') ? { includeAgentWait: true as const } : {})
  }
  // The recent view is where a bot looks for work, so it reaches paired servers too.
  const result =
    since === undefined
      ? await client.call<WithAnnotatedHostScope<RuntimeWorktreePsResult>>('worktree.ps', params)
      : await readWorktreePsAcrossServers(client, params)
  await annotateOmittedHostScope(result.result)
  const listed =
    since === undefined ? result.result : recentWorktreePs(result.result, Date.now() - since, limit)
  // Addresses name the client's own environment, so rows read across paired servers go without.
  const annotate =
    since === undefined
      ? await annotatePsRows(client, listed.worktrees)
      : <Row>(rows: Row[]): Row[] => rows
  const worktrees = annotate(listed.worktrees.map(projectWorktreePsTerminalVerdict))
  // Whose area a workspace may already be: the other bots, beside the work they might own.
  const otherBots = since === undefined ? [] : await otherBotsOf(client)
  printResult(
    { ...result, result: { ...listed, worktrees, ...(otherBots.length ? { otherBots } : {}) } },
    json,
    () =>
      formatWorktreePs({ ...listed, worktrees: annotate(listed.worktrees) }, Date.now(), otherBots)
  )
}

async function otherBotsOf(client: RuntimeClient): Promise<BotRosterEntry[]> {
  const roster = await client
    .call<{ bots: BotRosterEntry[] }>('bots.roster', callerChat())
    .catch(() => null)
  return roster?.result.bots.filter((bot) => !bot.self) ?? []
}
