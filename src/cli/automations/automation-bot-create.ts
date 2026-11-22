import {
  EVENT_ONLY_SCHEDULE,
  isConnectorTrigger,
  THREAD_REPLIES_UNSUPPORTED,
  type AutomationEventTrigger
} from '../../shared/automation-event-triggers'
import type {
  Automation,
  AutomationBotResultsTo,
  AutomationBotRunsIn,
  AutomationBotTarget
} from '../../shared/automations/automation-definition'
import {
  BOT_AGENTS,
  BOT_HELD_BACK_AGENTS,
  isBotAgent,
  type Bot,
  type BotAgent
} from '../../shared/bot-types'
import {
  botAutomationSetup,
  chatRunAgentSetupRefusal,
  type BotAgentSetup
} from '../../shared/bots/bot-agent-setup'
import { BotLaunchSchema, botLaunchFromChoices } from '../../shared/bots/bot-launch'
import { botEventTriggerRefusal } from '../../shared/bot-event-sources'
import type { HandlerContext } from '../dispatch/dispatch'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import { RuntimeClientError } from '../runtime/connection/types'
import { findBot } from '../bots/bot'
import { getEnabledFlag, getPrecheckFlag } from './automation-handler-flags'
import { getTimezoneFlags } from './automation-timezone-flag'
import { legacyPlaceOf } from '../../shared/connector-place-names'
import { callerChat } from './automation-caller-chat'
import { BOT_CHAT_ID_PREFIX } from '../../shared/bots/bot-chat-row'
import type { AutomationOnce } from '../../shared/automation-once'

// A bot brings its own folder and session, so these flags have nothing to set.
const NOT_WITH_BOT_FLAGS = [
  'repo',
  'workspace',
  'project',
  'host',
  'project-host-setup',
  'source-context',
  'workspace-mode',
  'base-branch',
  'reuse-session',
  'fresh-session'
]

const NOT_WITH_BOT_REFUSALS: Record<string, string> = {
  provider:
    '--provider cannot be used with --bot; use --agent <agent> (with --model/--effort) to run this automation on another agent.',
  'extra-agent-args':
    "A bot's runs are chats and take no agent arguments; use --model and --effort."
}

/** --agent, --model and --effort on a bot's automation; `--agent bot` goes back to the bot's own. */
export type BotAgentSetupEdit =
  | { kind: 'clear' }
  | { kind: 'set'; agent?: BotAgent; model?: string; effort?: string }

/** Read like worker-start's --agent, --model and --effort; undefined when none is given. */
export function getBotAgentSetupEdit(
  flags: Map<string, string | boolean>
): BotAgentSetupEdit | undefined {
  const agent = getOptionalStringFlag(flags, 'agent')
  const model = getOptionalStringFlag(flags, 'model')
  const effort = getOptionalStringFlag(flags, 'effort')
  if (agent === undefined && model === undefined && effort === undefined) {
    return undefined
  }
  if (agent === 'bot') {
    if (model !== undefined || effort !== undefined) {
      throw new RuntimeClientError(
        'invalid_argument',
        "--agent bot uses the bot's own model; drop --model and --effort."
      )
    }
    return { kind: 'clear' }
  }
  if (agent !== undefined && !isBotAgent(agent)) {
    const heldBack = BOT_HELD_BACK_AGENTS.some((entry) => entry === agent)
    throw new RuntimeClientError(
      'invalid_argument',
      `Bots can't run on ${agent}${heldBack ? ' yet' : ''}; use one of: ${BOT_AGENTS.join(', ')}.`
    )
  }
  return { kind: 'set', ...(agent ? { agent } : {}), model, effort }
}

/**
 * The setup an edit leaves, from what runs now (`base`): the same agent keeps its launch and takes
 * the new choices; another agent starts from its own defaults, since a launch belongs to its agent.
 */
export function applyBotAgentSetupEdit(
  base: BotAgentSetup,
  edit: BotAgentSetupEdit
): BotAgentSetup | undefined {
  if (edit.kind === 'clear') {
    return undefined
  }
  const agent = edit.agent ?? base.agent
  const kept = agent === base.agent ? base.launch : undefined
  const launch = botLaunchFromChoices({
    model: edit.model ?? kept?.model,
    options: { ...kept?.options, ...(edit.effort ? { effort: edit.effort } : {}) }
  })
  if (launch && !BotLaunchSchema.safeParse(launch).success) {
    throw new RuntimeClientError('invalid_argument', 'Invalid launch choice')
  }
  return { agent, ...(launch ? { launch } : {}) }
}

/** The target with an agent edit applied; one that continues a chat keeps that chat's agent. */
function withAgentSetup(
  target: AutomationBotTarget,
  edit: BotAgentSetupEdit | undefined,
  bot: Pick<Bot, 'agent' | 'launch'> | undefined
): AutomationBotTarget {
  const next = { ...target }
  if (edit) {
    const base = target.agentSetup ?? (bot ? { agent: bot.agent, launch: bot.launch } : null)
    if (!base) {
      throw new RuntimeClientError('invalid_argument', 'The bot this automation runs as is gone.')
    }
    const setup = applyBotAgentSetupEdit(base, edit)
    if (setup) {
      next.agentSetup = setup
    } else {
      delete next.agentSetup
    }
  }
  if (next.agentSetup && next.runsIn !== 'new') {
    throw new RuntimeClientError('invalid_argument', chatRunAgentSetupRefusal())
  }
  return next
}

type RunsInChoice = Pick<AutomationBotTarget, 'runsIn' | 'chat'>

/** new, chat (the Home Chat), or chat:<id> for one of the bot's chats as `orca bot chats` prints it. */
function parseRunsIn(raw: string | undefined, fallback: AutomationBotRunsIn): RunsInChoice {
  if (raw === undefined || raw === 'new' || raw === 'chat') {
    return { runsIn: raw ?? fallback }
  }
  const id = raw.startsWith(BOT_CHAT_ID_PREFIX) ? raw.slice(BOT_CHAT_ID_PREFIX.length).trim() : ''
  if (id) {
    return { runsIn: 'chat', chat: { sessionId: id } }
  }
  throw new RuntimeClientError('invalid_argument', '--runs-in must be new, chat or chat:<id>')
}

function parseResultsTo(raw: string | undefined): AutomationBotResultsTo | undefined {
  if (raw === undefined || raw === 'chat' || raw === 'none' || raw === 'thread') {
    return raw
  }
  const [kind, ...rest] = raw.split(':')
  const place = rest.join(':').trim()
  // An id or key in its one spelling; the host looks a #name, link or ref up.
  if (place && kind === 'channel') {
    return { channel: legacyPlaceOf('slack', place) ?? place }
  }
  if (place && kind === 'linear') {
    return { linearIssue: place }
  }
  throw new RuntimeClientError(
    'invalid_argument',
    '--results-to must be chat, thread, none, channel:<channel> or linear:<issue>'
  )
}

// A run started only by Slack, GitHub or Linear events answers in that event's thread unless told
// otherwise, where the host's Orca Cloud can bind the thread.
function defaultResultsTo(
  runsIn: AutomationBotRunsIn,
  on: readonly AutomationEventTrigger[] | undefined,
  schedule: { dtstart: number },
  threadReplies: boolean
): AutomationBotResultsTo {
  const eventsOnly = schedule.dtstart === EVENT_ONLY_SCHEDULE.dtstart && Boolean(on?.length)
  return threadReplies && eventsOnly && runsIn === 'new' && (on ?? []).every(isConnectorTrigger)
    ? 'thread'
    : 'chat'
}

/** The bot target named by --bot, or null when the automation targets a project. A wait answers
 *  the person who asked, so it runs in the bot's Chat and reports there unless told otherwise; the
 *  host moves one made from another of the bot's chats, and a teammate's automation, to that chat. */
export async function getBotTargetFlags(
  flags: Map<string, string | boolean>,
  client: HandlerContext['client'],
  on: readonly AutomationEventTrigger[] | undefined,
  schedule: { dtstart: number },
  once?: AutomationOnce
): Promise<{ bot: Bot; target: AutomationBotTarget } | null> {
  const selector = getOptionalStringFlag(flags, 'bot')
  const agentEdit = getBotAgentSetupEdit(flags)
  if (!selector) {
    // Only a bot's automations start on events.
    if (flags.has('runs-in') || flags.has('results-to') || flags.has('on') || once) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--runs-in, --results-to, --on and --once need --bot'
      )
    }
    if (agentEdit) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--agent, --model and --effort need --bot; a project automation takes --provider.'
      )
    }
    return null
  }
  // Either starts runs, so both would run on a schedule nobody asked for beside the events.
  if (on?.length && (flags.has('trigger') || flags.has('schedule'))) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--on starts a run on each event, so drop --trigger; for a schedule as well, create a second automation with --trigger.'
    )
  }
  const refused = Object.keys(NOT_WITH_BOT_REFUSALS).find((flag) => flags.has(flag))
  if (refused) {
    throw new RuntimeClientError('invalid_argument', NOT_WITH_BOT_REFUSALS[refused])
  }
  const conflict = NOT_WITH_BOT_FLAGS.find((flag) => flags.has(flag))
  if (conflict) {
    throw new RuntimeClientError('invalid_argument', `--${conflict} cannot be used with --bot`)
  }
  const runsInChoice = parseRunsIn(getOptionalStringFlag(flags, 'runs-in'), once ? 'chat' : 'new')
  const { runsIn } = runsInChoice
  const asked = parseResultsTo(getOptionalStringFlag(flags, 'results-to'))
  // Listing first also refuses a host without bots, which would drop the bot and target cwd.
  const bot = await findBot(client, selector)
  if (asked === 'thread' && !bot.threadReplies) {
    throw new RuntimeClientError('invalid_argument', THREAD_REPLIES_UNSUPPORTED)
  }
  const resultsTo =
    asked ?? (once ? 'chat' : defaultResultsTo(runsIn, on, schedule, bot.threadReplies))
  return {
    bot,
    target: withAgentSetup({ botId: bot.id, ...runsInChoice, resultsTo }, agentEdit, bot)
  }
}

/** What an edit's --runs-in and --results-to change; parsed before any host call, so a bad one fails first. */
export function getBotTargetEditFlags(
  flags: Map<string, string | boolean>
): Partial<Pick<AutomationBotTarget, 'runsIn' | 'chat' | 'resultsTo'>> {
  return {
    // A new --runs-in replaces the saved chat, so one without chat:<id> clears it.
    ...(flags.has('runs-in')
      ? { chat: undefined, ...parseRunsIn(getRequiredStringFlag(flags, 'runs-in'), 'new') }
      : {}),
    ...(flags.has('results-to')
      ? { resultsTo: parseResultsTo(getRequiredStringFlag(flags, 'results-to')) ?? 'chat' }
      : {})
  }
}

/** Whether an edit needs the live bot: a new setup with none saved starts from what the bot runs. */
export function editNeedsBot(
  automation: Pick<Automation, 'bot'>,
  agentEdit: BotAgentSetupEdit | undefined
): boolean {
  return agentEdit?.kind === 'set' && automation.bot !== undefined && !automation.bot.agentSetup
}

/** The saved bot target with an edit's changes; undefined when the edit changes none of them. */
export function editedBotTarget(
  automation: Pick<Automation, 'bot'>,
  edits: Partial<Pick<AutomationBotTarget, 'runsIn' | 'chat' | 'resultsTo'>>,
  agentEdit?: BotAgentSetupEdit,
  bot?: Pick<Bot, 'agent' | 'launch'>
): AutomationBotTarget | undefined {
  if (edits.runsIn === undefined && edits.resultsTo === undefined && !agentEdit) {
    return undefined
  }
  if (!automation.bot) {
    throw new RuntimeClientError(
      'invalid_argument',
      "--runs-in, --results-to, --agent, --model and --effort apply only to a bot's automation"
    )
  }
  return withAgentSetup({ ...automation.bot, ...edits }, agentEdit, bot)
}

/** A bot automation names only the bot; the host fills in its folder and agent. */
export async function createBotAutomation(
  client: HandlerContext['client'],
  flags: Map<string, string | boolean>,
  { bot, target }: { bot: Bot; target: AutomationBotTarget },
  schedule: { rrule: string; dtstart: number },
  on: AutomationEventTrigger[] | undefined,
  once?: AutomationOnce
) {
  // Checked here too, since an older host saves the rule and it never fires.
  const refusal = botEventTriggerRefusal(bot, on ?? [])
  if (refusal) {
    throw new RuntimeClientError('invalid_argument', refusal)
  }
  return client.call<{ automation: Automation }>('automation.create', {
    name: getRequiredStringFlag(flags, 'name'),
    prompt: getRequiredStringFlag(flags, 'prompt'),
    precheck: getPrecheckFlag(flags),
    agentId: botAutomationSetup(target, bot).agent,
    bot: target,
    workspaceMode: 'existing',
    ...getTimezoneFlags(flags),
    enabled: getEnabledFlag(flags),
    missedRunGraceMinutes: getOptionalPositiveIntegerFlag(flags, 'missed-run-grace-minutes'),
    ...schedule,
    ...(on?.length ? { on } : {}),
    ...(once ? { once } : {}),
    ...callerChat(),
    ...(flags.has('runs-in') ? {} : { runsInDefault: true })
  })
}
