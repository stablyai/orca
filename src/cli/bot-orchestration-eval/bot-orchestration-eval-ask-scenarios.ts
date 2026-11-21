import { makeTestBotItem } from '../../shared/bots/bot-item.test-fixture'
import { BOT_CREATED_KICKOFF } from '../../shared/bot-created-kickoff'
import { starterSoul } from '../../shared/bot-soul'
import { EVAL_BOT } from '../bot-automation-eval/bot-automation-eval-host'
import type { StandInMessage } from './bot-orchestration-eval-mail'
import type { OrchestrationScenario } from './bot-orchestration-eval-scenarios'
import {
  EMPTY_WORLD,
  ORCA_REPO,
  OWNER_WORKSPACES,
  WOKEN,
  runningWorker,
  workspace
} from './bot-orchestration-eval-fixtures'
import { noStart, asksWithoutActions, asksOneQuestion } from './bot-orchestration-eval-grading'
import { selfContainedWorkerAsk, briefAskWithoutWorker } from './bot-orchestration-eval-ask-grading'

/** A worker's `orchestration ask`, as it reaches the bot's run. */
function workerQuestion(dispatchId: string, body: string): StandInMessage[] {
  return [
    {
      id: `msg_ask_${dispatchId}`,
      from_handle: `dispatch:${dispatchId}`,
      type: 'question',
      subject: 'question',
      body,
      payload: JSON.stringify({ dispatchId })
    }
  ]
}

const CARD_WORKSPACE = workspace({
  repoId: ORCA_REPO,
  repo: 'orca',
  name: 'waiting-card-spacing',
  state: 'working',
  prompt: 'Fix the spacing of the "waiting on you" card in bot chats.',
  last: 'Reviewing the card in narrow windows.'
})

const CARD_QUESTION = workerQuestion(
  'ctx_w1',
  "Item 41 tracks this work. Spacing is fixed. My review found two more problems, OWNER-1 and CS-C4-1. OWNER-1: the card's orange edge is cut off when the window is narrow. CS-C4-1: Answer opens the wrong chat when the bot has several chats. Fixing both now adds about a day before this can merge; otherwise I file them for D3, the follow-up batch. This is a scope call for the owner: fix both now, or merge the spacing fix and defer them to D3?"
)

// Worded apart from the card case and never used to tune the rule.
const MIGRATION_WORKSPACE = workspace({
  repoId: ORCA_REPO,
  repo: 'orca',
  name: 'invoice-status-migration',
  state: 'working',
  prompt: 'Add a status column to invoices.',
  last: 'Testing the migration on a copy of production.'
})

const MIGRATION_QUESTION = workerQuestion(
  'ctx_w1',
  "Migration M-12 is ready, but on a production-sized copy it holds a write lock on T3 (the invoices table) for about four minutes; nobody can save an invoice during that time. Options: run M-12 in tonight's maintenance window as is, or rewrite it as an online migration, which takes about two more days. The owner should decide which."
)

function workerWorld(space: Record<string, unknown>, spec: string) {
  return {
    ...EMPTY_WORLD,
    worktrees: [space, ...OWNER_WORKSPACES],
    workers: [runningWorker(space.worktreeId, spec)]
  }
}

const MIGRATION_RUN = String.raw`\b(?:run(?:ning)?(?:\s+(?:the\s+)?migration)?\s+tonight|tonight['’]s\s+(?:run|migration)|as.is\s+migration|run(?:ning)?(?:\s+(?:the\s+)?migration)?\s+as.is)\b`
const ONLINE_REWRITE = String.raw`\b(?:online\s+migration|(?:online\s+)?rewrite)\b`
const BLOCK_SAVE_PREDICATE = String.raw`(?:block|prevent|stop|interrupt)\w*`
const TWO_DAY_PREDICATE = String.raw`(?:takes?|costs?|adds?|needs?)`
const BLOCKED_SAVES = String.raw`(?:\b${BLOCK_SAVE_PREDICATE}.*?\b(?:invoice\s+)?(?:sav|writ)\w*|\b(?:invoice\s+)?(?:sav|writ)\w*.*?\b${BLOCK_SAVE_PREDICATE})`
const FOUR_MINUTE_BLOCK = String.raw`${BLOCKED_SAVES}.*?\b(?:4|four)\s+minutes?\b`
const TWO_DAY_COST = String.raw`\b${TWO_DAY_PREDICATE}\b.*?\b(?:2|two)\s+(?:more\s+|extra\s+)?days?\b`

// A different choice between the subject and consequence cannot supply that choice's cost.
function migrationCost(choice: string, otherChoice: string, cost: string): RegExp {
  return new RegExp(`(?:${choice})(?:(?!${otherChoice}).)*?(?:${cost})`, 'i')
}

export const ASK_SCENARIOS: OrchestrationScenario[] = [
  {
    id: 'ask-first-greeting-stays-brief',
    firstRun: true,
    soul: starterSoul(EVAL_BOT.name),
    turns: [{ message: BOT_CREATED_KICKOFF }],
    state: EMPTY_WORLD,
    checks: [[asksWithoutActions, noStart, briefAskWithoutWorker(2), asksOneQuestion]]
  },
  {
    id: 'ask-worker-question-self-contained',
    turns: [{ message: WOKEN, mail: CARD_QUESTION }],
    state: {
      ...workerWorld(CARD_WORKSPACE, 'Fix the spacing of the "waiting on you" card in bot chats.'),
      decisionItem: {
        item: makeTestBotItem(41, {
          title: 'Waiting card spacing',
          owner: { botId: EVAL_BOT.id, name: EVAL_BOT.name },
          chat: { id: '7d25c94a-f6da-41d3-b075-1823319fbbef', title: 'Home Chat', kind: 'home' }
        }),
        comments: []
      }
    },
    checks: [
      [
        noStart,
        selfContainedWorkerAsk({
          facts: [
            {
              pattern: /(?:spacing|card).*worker|worker.*(?:spacing|card)/i,
              what: 'the spacing worker'
            },
            {
              pattern: /(?:spacing|card).*(?:fix|work|finish)|(?:fix|work|finish).*spacing/i,
              what: 'the spacing work'
            },
            {
              pattern:
                /(?:edge|border).*(?:cut off|clipp|cropp).*(?:narrow|small)|(?:narrow|small).*(?:edge|border).*(?:cut off|clipp|cropp)/i,
              what: 'the clipped edge in narrow windows'
            },
            {
              pattern: /Answer.*(?:open|take|send).*(?:wrong|another) (?:chat|conversation)/i,
              what: 'Answer opening the wrong chat'
            },
            {
              pattern:
                /(?:fix(?:ing)?|address(?:ing)?|repair(?:ing)?).*(?:both|two|problems|issues).*(?:add|tak|took|cost|delay)\w*.*(?:a|one|1|another|extra) (?:more )?day/i,
              what: 'fixing both costs a day',
              predicate: '(?:add|tak|took|cost|delay)\\w*'
            },
            {
              pattern:
                /(?:merge|merging|ship|shipping|defer|deferring).*(?:leaves?|keeps?|risks?|means?).*(?:problems|issues|bugs|wrong chat|clipp|cut off)/i,
              what: 'deferring leaves the problems unresolved'
            }
          ],
          choices: [
            /(?:fix|fixing|address|addressing|repair|repairing).*(?:both|two|problems|issues).*(?:now|before)/i,
            /(?:merge|merging|ship|shipping).*spacing|defer|follow.up/i
          ],
          labels: [/OWNER-1/, /CS-C4-1/, /\bD3\b/]
        })
      ]
    ]
  },
  {
    id: 'ask-worker-question-held-out',
    heldOut: true,
    turns: [{ message: WOKEN, mail: MIGRATION_QUESTION }],
    state: workerWorld(MIGRATION_WORKSPACE, 'Add a status column to invoices.'),
    checks: [
      [
        noStart,
        selfContainedWorkerAsk({
          facts: [
            {
              pattern: /(?:invoice|migration).*worker|worker.*(?:invoice|migration)/i,
              what: 'the invoice worker'
            },
            {
              pattern: migrationCost(MIGRATION_RUN, ONLINE_REWRITE, FOUR_MINUTE_BLOCK),
              what: 'invoice saves are blocked for four minutes',
              predicate: BLOCK_SAVE_PREDICATE,
              contradictions: [
                { pattern: migrationCost(ONLINE_REWRITE, MIGRATION_RUN, FOUR_MINUTE_BLOCK) },
                {
                  pattern: migrationCost(MIGRATION_RUN, ONLINE_REWRITE, BLOCKED_SAVES),
                  negated: true
                }
              ]
            },
            {
              pattern: migrationCost(ONLINE_REWRITE, MIGRATION_RUN, TWO_DAY_COST),
              what: 'the online rewrite costs two days',
              predicate: TWO_DAY_PREDICATE,
              contradictions: [
                { pattern: migrationCost(MIGRATION_RUN, ONLINE_REWRITE, TWO_DAY_COST) },
                {
                  pattern: migrationCost(ONLINE_REWRITE, MIGRATION_RUN, TWO_DAY_COST),
                  negated: true
                }
              ]
            }
          ],
          choices: [
            /run.*(?:tonight|maintenance)|(?:tonight|maintenance).*run/i,
            /online.*(?:rewrite|migration)|rewrite.*online|\brewrite\b/i
          ],
          labels: [/M-12/, /\bT3\b/]
        })
      ]
    ]
  },
  {
    // No worker behind the question: no worker link, and no long setup before it.
    id: 'ask-without-worker-stays-brief',
    turns: [{ message: 'Fix the login bug. I have not told you which project it is in yet.' }],
    state: EMPTY_WORLD,
    checks: [[noStart, briefAskWithoutWorker(2)]]
  }
]
