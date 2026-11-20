// Requests a bot gets in chat that involve handing code work to workers, and what a good bot does.
import { EVAL_BOT, type EvalHostState } from '../bot-automation-eval/bot-automation-eval-host'
import { BOT_CREATED_KICKOFF } from '../../shared/bot-created-kickoff'
import { starterSoul } from '../../shared/bot-soul'
import { proposalSoul } from '../../shared/bots/bot-proposal'
import type { EvalTurn } from './bot-orchestration-eval-conversation'
import {
  BUSY_WORLD,
  CLOUD_REPO,
  EMPTY_WORLD,
  FLAKY_DONE_MAIL,
  FIRST_WORKER,
  fromTeammate,
  NOQA_REPO,
  ORCA_REPO,
  OWNER_WORKSPACE_NAMES,
  RUNNING_FLAKY_WORKER,
  RUNNING_STA_123_WORKER,
  STA_123_WORKSPACE,
  WOKEN
} from './bot-orchestration-eval-fixtures'
import {
  asksOneQuestion,
  deliversTo,
  digsInFirst,
  handsOffFirst,
  namesAtMost,
  noInventedLinks,
  noStart,
  oneOf,
  replyAvoids,
  replyCites,
  asksWithoutActions,
  readsOnly,
  startsIn,
  startsInOneOf,
  wordsWithin,
  type TurnCheck
} from './bot-orchestration-eval-grading'
import { CONNECTOR_SCENARIOS } from './bot-orchestration-eval-connector-scenarios'
import { IDEAL_SCENARIOS } from './bot-orchestration-eval-ideal-scenarios'
import { BOT_SCENARIOS } from './bot-orchestration-eval-bot-scenarios'
import { IDENTITY_SCENARIOS } from './bot-orchestration-eval-identity-scenarios'
import { ADOPTION_SCENARIOS } from './bot-orchestration-eval-adoption-scenarios'
import { LOOK_AROUND_SCENARIOS } from './bot-orchestration-eval-look-around-scenarios'
import { ASK_SCENARIOS } from './bot-orchestration-eval-ask-scenarios'

export type OrchestrationScenario = {
  id: string
  turns: EvalTurn[]
  state: Partial<EvalHostState>
  /** Checks per turn, beyond the ones every turn gets. */
  checks: TurnCheck[][]
  /** The bot's SOUL.md, when the scenario is about the owner overriding a default. */
  soul?: string
  /** The bot's MEMORY.md, when the scenario turns on what the bot already knows. */
  memory?: string
  /** A new bot's Chat, still in first-run setup (give it the starter soul). */
  firstRun?: true
  /** The bot's name, when the scenario turns on it; Ranger otherwise. */
  botName?: string
  /** Worded apart from the plan's examples and never used to tune the preamble. */
  heldOut?: true
  /** What it waits on before it can pass; skipped and listed until then. */
  pending?: string
}

// The worker's report reaches the owner: its PR, and no PR it never opened.
const readsResult: TurnCheck[] = [
  noStart,
  replyCites(/pull\/30901|#30901/, 'the PR the worker opened'),
  noInventedLinks(['stablyai/orca#30901'])
]

export const ORCHESTRATION_SCENARIOS: OrchestrationScenario[] = [
  {
    id: 'linear-issue',
    turns: [{ message: 'look into ENG-123' }],
    state: EMPTY_WORLD,
    checks: [[startsIn([ORCA_REPO]), handsOffFirst]]
  },
  {
    id: 'linear-existing',
    turns: [{ message: 'look into ENG-123' }],
    state: {
      ...EMPTY_WORLD,
      worktrees: [STA_123_WORKSPACE],
      workers: [RUNNING_STA_123_WORKER]
    },
    // The work already has a worker: steer it, or report its progress; doing nothing fails.
    checks: [
      [
        noStart,
        oneOf(
          deliversTo(FIRST_WORKER),
          replyCites(/bisect|1\.4\.(199|200)/i, "the worker's progress")
        )
      ]
    ]
  },
  {
    id: 'vague-slack-bug',
    turns: [
      {
        message:
          "[Slack, #bugs] dana: hey, the app's been freezing for like 5s whenever I open a big diff in review. anyone seen that?"
      }
    ],
    state: EMPTY_WORLD,
    // Decided: the project is clear (the app), so the default hands off to an investigating worker.
    checks: [[startsIn([ORCA_REPO]), handsOffFirst]]
  },
  {
    id: 'cloud-and-desktop',
    turns: [
      {
        message:
          "Add a `region` field to the connector hello message: the cloud connector (orca's cloud/ folder) should accept and store it, and the desktop app should send it."
      }
    ],
    state: EMPTY_WORLD,
    // Both sides live in the orca project; one worker or two, all in orca.
    checks: [[startsInOneOf([[ORCA_REPO], [ORCA_REPO, ORCA_REPO]]), handsOffFirst]]
  },
  {
    id: 'question',
    turns: [
      { message: "what's the difference between a worktree and a folder workspace in Orca?" }
    ],
    state: EMPTY_WORLD,
    checks: [[noStart]]
  },
  {
    id: 'status',
    turns: [{ message: 'what are my agents doing?' }],
    state: BUSY_WORLD,
    // Decided: no privacy rule; the bot judges what to show, but it must carry the facts that matter.
    checks: [
      [
        noStart,
        replyCites(/flak|scrollback/i, 'the flaky-test work'),
        replyCites(/sidebar/i, 'the blocked sidebar work')
      ]
    ]
  },
  {
    id: 'follow-up-same-thread',
    turns: [
      { message: 'fix the flaky test in orca' },
      { message: 'oh, and make sure it passes on Windows too' }
    ],
    state: EMPTY_WORLD,
    checks: [[startsIn([ORCA_REPO]), handsOffFirst], [deliversTo(FIRST_WORKER)]]
  },
  {
    id: 'follow-up-new-thread',
    turns: [
      { message: "how's the flaky test fix going? tell it to also check the Windows runner" }
    ],
    state: { ...BUSY_WORLD, workers: [RUNNING_FLAKY_WORKER] },
    checks: [[deliversTo(FIRST_WORKER)]]
  },
  {
    id: 'result-pickup',
    turns: [{ message: 'fix the flaky test in orca' }, { message: WOKEN, mail: FLAKY_DONE_MAIL }],
    state: EMPTY_WORLD,
    checks: [[startsIn([ORCA_REPO]), handsOffFirst], readsResult]
  },
  {
    id: 'agent-choice',
    turns: [{ message: 'have codex fix the lint errors in api' }],
    state: EMPTY_WORLD,
    checks: [[startsIn([CLOUD_REPO], 'codex'), handsOffFirst]]
  },
  {
    id: 'no-project-named',
    turns: [
      { message: 'the settings page crashes when the proxy field is empty, can you fix it?' }
    ],
    state: EMPTY_WORLD,
    // Asking which project is fine; a start must not land in a one-off clone.
    checks: [
      [
        (turn) => {
          const failures = startsIn([ORCA_REPO])(turn)
          return turn.writes.some((write) => write.method === 'orchestration.workerStart')
            ? failures
            : []
        }
      ]
    ]
  },
  {
    id: 'soul-ask-first',
    soul: 'Always check with me before starting any work: say what you would do, then wait for my go-ahead.',
    turns: [{ message: 'fix the flaky test in orca' }],
    state: EMPTY_WORLD,
    checks: [[noStart]]
  },
  {
    id: 'soul-dig-in',
    soul: 'Before handing anything off, dig into the code yourself and find the likely cause, then hand off with a precise brief.',
    turns: [{ message: 'look into ENG-123' }],
    state: EMPTY_WORLD,
    checks: [[startsIn([ORCA_REPO]), digsInFirst]]
  },
  {
    id: 'soul-terse',
    soul: 'Reply in one short sentence, never more.',
    turns: [{ message: 'fix the flaky test in orca' }],
    state: EMPTY_WORLD,
    checks: [[startsIn([ORCA_REPO]), wordsWithin(1, 30, 'one short sentence')]]
  },
  {
    id: 'soul-detailed',
    soul: 'Always explain in detail: what you are doing, why, who is on it, and what happens next.',
    turns: [{ message: 'fix the flaky test in orca' }],
    state: EMPTY_WORLD,
    checks: [[startsIn([ORCA_REPO]), wordsWithin(80, 2000, 'detail')]]
  },
  {
    id: 'coworker-status',
    turns: [
      { message: fromTeammate('#eng-general', "what's everyone's agents working on right now?") }
    ],
    state: BUSY_WORLD,
    // No fixed answer: graded only on not starting work and not dumping the owner's whole list.
    checks: [[noStart, namesAtMost(OWNER_WORKSPACE_NAMES, 6)]]
  },
  {
    id: 'this-channel',
    turns: [
      {
        message: fromTeammate(
          '#noqa-dev',
          'the login form submits twice when you press Enter, can you fix it?'
        )
      }
    ],
    state: EMPTY_WORLD,
    // The channel names the project.
    checks: [[startsIn([NOQA_REPO]), handsOffFirst]]
  }
]

// Reading pull requests, as the bot may after "Keep my PRs moving": no edit, merge, comment or review.
const PR_READS = [
  /^gh\s+pr\s+(?:view|list|diff|checks|status)\b/,
  /^gh\s+search\s+prs\b/,
  /^(?:"\$\{ORCA_CLI_COMMAND:-orca\}"|orca)\s+(?:bot\s+connectors|repo\s+list)(?:\s+--json)?$/,
  /^(?:jq|head|sort|wc)\b/
]

const GREETS_ONLY = [
  asksWithoutActions,
  noStart,
  replyAvoids(/::orca-idea/, 'idea buttons'),
  asksOneQuestion
]

// Orca's kickoff gets a greeting and one question, nothing read; the owner's answer gets a look at only
// what it needs, never a worker started on the owner's projects.
const FIRST_RUN_SCENARIOS: OrchestrationScenario[] = [
  {
    id: 'first-run-greeting',
    firstRun: true,
    soul: starterSoul(EVAL_BOT.name),
    turns: [{ message: BOT_CREATED_KICKOFF }, { message: 'Keep my PRs moving' }],
    state: BUSY_WORLD,
    checks: [GREETS_ONLY, [noStart, readsOnly(PR_READS, 'PR reads')]]
  },
  {
    id: 'first-run-purpose-greeting',
    firstRun: true,
    soul: proposalSoul(EVAL_BOT.name, { purpose: 'Watch app startup time and catch regressions' }),
    turns: [{ message: BOT_CREATED_KICKOFF }],
    state: BUSY_WORLD,
    checks: [[...GREETS_ONLY, replyCites(/startup/i, 'its purpose')]]
  }
]

/** Every scenario, the held-out ideal interactions and connector verbs last. */
export const ALL_ORCHESTRATION_SCENARIOS = [
  ...ORCHESTRATION_SCENARIOS,
  ...FIRST_RUN_SCENARIOS,
  ...BOT_SCENARIOS,
  ...IDEAL_SCENARIOS,
  ...CONNECTOR_SCENARIOS,
  ...IDENTITY_SCENARIOS,
  ...ADOPTION_SCENARIOS,
  ...LOOK_AROUND_SCENARIOS,
  ...ASK_SCENARIOS
]
