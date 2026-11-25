// A bot session's launch instructions, recorded in its turn context as what its agent was given.
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import type { Bot } from '../../shared/bot-types'
import { botRulesBlock, botSessionPreamble } from './bot-preamble'
import { type BotHomeFilesystem, localBotHomeFilesystem } from './bot-home'
import type { BotTurnContext } from './bot-turn-context'

function startsFresh(record: BotSessionLaunch): boolean {
  return record.instructionsEachStart || record.providerHandleChain.length === 0
}

/** Orca's Tools and Rules reach the context only when its prompt is built now: a fork may carry on
 *  its source's thread, so only an agent that rebuilds its prompt counts it as given. */
function rulesDelivered(record: BotSessionLaunch): boolean {
  return (
    record.instructionsEachStart || (record.providerHandleChain.length === 0 && !record.forkedFrom)
  )
}

type BotSessionLaunch = Pick<
  AgentSessionRecord,
  'sessionId' | 'provider' | 'instructionsKey' | 'forkedFrom'
> & {
  location: Pick<AgentSessionRecord['location'], 'workspaceId'>
  /** Empty until the provider has a conversation to resume. */
  providerHandleChain: readonly unknown[]
  /** See `StructuredAgentDefinition.instructionsEachStart`. */
  instructionsEachStart: boolean
}

/** A bot session's preamble, read from the folder it runs in, recorded as what its agent has. */
export async function botSessionInstructions(
  context: Pick<BotTurnContext, 'launched' | 'linkedSkillsLaunched'>,
  bots: readonly (Pick<Bot, 'id' | 'name' | 'agent' | 'folderWorkspaceId'> &
    Partial<Pick<Bot, 'skillProjects'>>)[],
  record: BotSessionLaunch,
  launchDirectory: string,
  /** How to use its linked projects' skills; a resumed agent gets it on its next turn. */
  linkedSkills: string | null = null,
  fs: Pick<BotHomeFilesystem, 'readText'> = localBotHomeFilesystem
): Promise<string | null> {
  let neverLinked = false
  const preamble = await botSessionPreamble(
    bots,
    {
      sessionId: record.sessionId,
      workspaceId: record.location.workspaceId,
      launchDirectory,
      provider: record.provider
    },
    fs,
    (bot, files, agent) => {
      // Unlinking leaves an empty list, so a bot without one never had linked skills to replace.
      neverLinked = bot.skillProjects === undefined
      context.launched(record.sessionId, bot.id, launchDirectory, files, startsFresh(record), {
        block: botRulesBlock(agent),
        name: bot.name,
        delivered: rulesDelivered(record),
        recorded: record.instructionsKey ?? null,
        rebuilt: record.instructionsEachStart
      })
    }
  )
  if (preamble === null) {
    return null
  }
  context.linkedSkillsLaunched(
    record.sessionId,
    linkedSkills,
    startsFresh(record) || (neverLinked && linkedSkills === null)
  )
  return linkedSkills ? `${preamble}\n\n${linkedSkills}` : preamble
}
