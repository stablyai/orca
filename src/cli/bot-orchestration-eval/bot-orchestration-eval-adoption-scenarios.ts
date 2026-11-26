// A new bot looks at the workspaces its owner already has (bots adopting existing workspaces): it reads
// what each agent is actually doing, groups them by area, offers to take over what fits, and never
// claims another bot's.
import { EVAL_BOT } from '../bot-automation-eval/bot-automation-eval-host'
import { BOT_CREATED_KICKOFF } from '../../shared/bot-created-kickoff'
import { starterSoul } from '../../shared/bot-soul'
import {
  AUTOMATION_FIXTURES,
  COORDINATED_FIXTURES,
  FIXTURES
} from './bot-orchestration-eval-adoption-fixtures'
import {
  adoptionWorld,
  idOf,
  OTHER_BOT_SOULS,
  OTHER_BOTS
} from './bot-orchestration-eval-adoption-world'
import { neverOffers, offersArea, offersNothing } from './bot-orchestration-eval-adoption-grading'
import { noStart, replyCites, runsNothing } from './bot-orchestration-eval-grading'
import type { OrchestrationScenario } from './bot-orchestration-eval-scenarios'

const named = (fixture: Parameters<typeof idOf>[0]) => ({ id: idOf(fixture), name: fixture.name })

const WEBHOOKS = named(FIXTURES.WEBHOOKS)
const GPU_LOADER = named(FIXTURES.GPU_LOADER)
const SIDEBAR_PERF = named(FIXTURES.SIDEBAR_PERF)
const RELEASE = named(FIXTURES.RELEASE)
const SLACK_THREADS = named(FIXTURES.SLACK_THREADS)
const AUTOMATIONS = AUTOMATION_FIXTURES.map(named)

const SELF = { ...EVAL_BOT, agent: 'claude' as const }

const AUTOMATION_DOCS = named(FIXTURES.AUTOMATION_DOCS)

/** A new bot's first turn (Orca's kickoff), which only greets, then its owner saying what it is for, in a
 *  world of these workspaces and bots. */
function firstLook(
  id: string,
  fixtures: Parameters<typeof adoptionWorld>[0],
  purpose: string,
  check: OrchestrationScenario['checks'][number],
  options: { otherBots?: typeof OTHER_BOTS } = {}
): OrchestrationScenario {
  return {
    id,
    firstRun: true,
    soul: starterSoul(EVAL_BOT.name),
    turns: [{ message: BOT_CREATED_KICKOFF }, { message: purpose }],
    state: {
      ...adoptionWorld(fixtures),
      bots: [SELF, ...(options.otherBots ?? [])],
      ...(options.otherBots ? { souls: OTHER_BOT_SOULS } : {})
    },
    // The greeting reads nothing; after the answer it runs `worktree ps` itself.
    checks: [
      [noStart, runsNothing],
      [noStart, ...check]
    ]
  }
}

const BOTS_PURPOSE = 'You’re for the Orca bots work: the bot runtime, bot chats and connectors.'
const AUTOMATIONS_PURPOSE = 'You’re for the automations work in Orca. Keep it moving.'

export const ADOPTION_SCENARIOS: OrchestrationScenario[] = [
  // Named for its first task; its agent has done bots work since.
  firstLook('adopt-name-mismatch', [FIXTURES.WEBHOOKS], BOTS_PURPOSE, [
    offersArea({ topic: /\bbots?\b/i, include: [WEBHOOKS] })
  ]),
  // Four automation workspaces, differently named, are one area; the SSH one is something else, and the
  // one with no agent open has nothing to hand off.
  firstLook(
    'adopt-grouping',
    [...AUTOMATION_FIXTURES, FIXTURES.AUTOMATION_DOCS, FIXTURES.GPU_LOADER],
    AUTOMATIONS_PURPOSE,
    [
      offersArea({
        topic: /automation/i,
        include: AUTOMATIONS,
        min: 3,
        forbid: [GPU_LOADER, AUTOMATION_DOCS]
      })
    ]
  ),
  // Its PR merged nine days ago, but its agent is mid-way through terminal search.
  firstLook(
    'adopt-merged-pr-active',
    [FIXTURES.SIDEBAR_PERF],
    'You’re for Orca’s terminal: search, find and scrollback.',
    [offersArea({ topic: /scrollback|search|find|terminal/i, include: [SIDEBAR_PERF] })]
  ),
  // Release work is Shipper's already; only the unowned bots work is the new bot's to offer.
  firstLook(
    'adopt-already-owned',
    [FIXTURES.RELEASE, FIXTURES.WEBHOOKS],
    BOTS_PURPOSE,
    [offersArea({ topic: /\bbots?\b/i, include: [WEBHOOKS], forbid: [RELEASE] })],
    { otherBots: OTHER_BOTS.filter((bot) => bot.name === 'Shipper') }
  ),
  // A broad purpose that takes in the bots work, while Atlas exists for exactly that: point to Atlas,
  // never claim it.
  firstLook(
    'adopt-other-bots-area',
    [FIXTURES.SLACK_THREADS],
    'You’re for my work on the Orca app.',
    [neverOffers(SLACK_THREADS), replyCites(/\bAtlas\b/, 'that Atlas owns this area')],
    { otherBots: OTHER_BOTS }
  ),
  // The owner gives it Atlas's area outright: it offers the workspace and mentions Atlas.
  firstLook(
    'adopt-other-bots-area-given',
    [FIXTURES.SLACK_THREADS],
    'You’re for Orca’s Slack side: how bots answer in Slack.',
    [
      offersArea({ topic: /slack/i, include: [SLACK_THREADS] }),
      replyCites(/\bAtlas\b/, 'that Atlas covers similar ground')
    ],
    { otherBots: OTHER_BOTS }
  ),
  // A purpose none of the workspaces fits: nothing to offer.
  firstLook(
    'adopt-purpose-no-fit',
    [...AUTOMATION_FIXTURES, FIXTURES.WEBHOOKS, FIXTURES.GPU_LOADER],
    'You’re for my Linear inbox: triage new issues each morning.',
    [offersNothing]
  ),
  // A coordinator whose own exchanges are generic started three workspaces on bot tools: the offer
  // groups it with them.
  firstLook(
    'adopt-coordinator-children',
    COORDINATED_FIXTURES,
    'You’re for bot tools in Orca: MCP tools, their templates and sign-in.',
    [offersArea({ topic: /tool|mcp/i, include: COORDINATED_FIXTURES.map(named) })]
  ),
  // Agents closed, or idle on finished questions: nothing to offer.
  firstLook('adopt-nothing-actionable', [], AUTOMATIONS_PURPOSE, [offersNothing])
]
