// orca-fork: the owner's "Can build a team" switch per bot, read and set on the bot's host.
import {
  AgentTeamsGet,
  AgentTeamsSet
} from '../../../shared/rpc-contract/orca-fork-agent-teams-params'
import { assertBotGroupOwner } from '../../runtime/rpc/methods/bot-groups'
import { defineMethod, InvalidArgumentError } from '../../runtime/rpc/core'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { agentTeamStore } from './agent-team-offer'

function assertBot(runtime: OrcaRuntimeService, botId: string): void {
  runtime.bots.assertEnabled()
  if (!runtime.bots.list().some((bot) => bot.id === botId)) {
    throw new InvalidArgumentError('bot_not_found')
  }
}

export const AGENT_TEAM_METHODS = [
  defineMethod({
    name: 'orcaFork.teams.get',
    permission: 'workspace',
    params: AgentTeamsGet,
    handler: ({ botId }, { runtime }) => {
      assertBot(runtime, botId)
      return agentTeamStore().view(botId)
    }
  }),
  defineMethod({
    name: 'orcaFork.teams.set',
    permission: 'workspace',
    params: AgentTeamsSet,
    handler: ({ botId, teamBuilder, dailyCap }, context) => {
      // Only the owner grants it; a bot can't give itself the permission.
      assertBotGroupOwner(context)
      assertBot(context.runtime, botId)
      agentTeamStore().set(botId, { teamBuilder, ...(dailyCap ? { dailyCap } : {}) })
      return agentTeamStore().view(botId)
    }
  })
]
