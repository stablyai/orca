// A bot session's launch instructions, recorded in its turn context as what its agent was given.
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import type { Bot } from '../../shared/bot-types'
import { botRulesBlock, botSessionPreamble } from './bot-preamble'
import { type BotHomeFilesystem, localBotHomeFilesystem } from './bot-home'
import type { BotTurnContext } from './bot-turn-context'

/** Agents that rebuild their system prompt from the instructions every start passes them (Pi's and
 *  Auggie's --append-system-prompt, Antigravity's reopen `_meta`, Copilot's instruction folders,
 *  Goose's `.goosehints`, Kilo's inline config, Gemini's GEMINI.md, Qwen's QWEN.md, Cline's rules,
 *  Droid's --append-system-prompt-file, CodeBuddy's CODEBUDDY.local.md); other agents keep a
 *  resumed thread's first ones. Claude records its prompt per conversation and reuses it on resume
 *  until compaction. */
const READS_INSTRUCTIONS_EACH_START: ReadonlySet<string> = new Set([
  'pi',
  'antigravity',
  'copilot',
  'aug',
  'goose',
  'kilo',
  'gemini',
  'droid',
  'qwen-code',
  'cline',
  'codebuddy'
])

function startsFresh(record: BotSessionLaunch): boolean {
  return (
    READS_INSTRUCTIONS_EACH_START.has(record.provider) || record.providerHandleChain.length === 0
  )
}

/** Orca's Tools and Rules reach the context only when its prompt is built now: a fork may carry on
 *  its source's thread, so only an agent that rebuilds its prompt counts it as given. */
function rulesDelivered(record: BotSessionLaunch): boolean {
  return (
    READS_INSTRUCTIONS_EACH_START.has(record.provider) ||
    (record.providerHandleChain.length === 0 && !record.forkedFrom)
  )
}

type BotSessionLaunch = Pick<
  AgentSessionRecord,
  'sessionId' | 'provider' | 'instructionsKey' | 'forkedFrom'
> & {
  location: Pick<AgentSessionRecord['location'], 'workspaceId'>
  /** Empty until the provider has a conversation to resume. */
  providerHandleChain: readonly unknown[]
}

/** A bot session's preamble, read from the folder it runs in, recorded as what its agent has. */
export async function botSessionInstructions(
  context: Pick<BotTurnContext, 'launched' | 'linkedSkillsLaunched'>,
  bots: readonly (Pick<Bot, 'id' | 'name' | 'agent' | 'folderWorkspaceId'> &
    Partial<Pick<Bot, 'skillProjects' | 'systemRole'>>)[],
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
        block: botRulesBlock(agent, bot.systemRole),
        name: bot.name,
        delivered: rulesDelivered(record),
        recorded: record.instructionsKey ?? null,
        rebuilt: READS_INSTRUCTIONS_EACH_START.has(record.provider)
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
