// Whether a bot picks the right command first, unprompted: each scenario is a mistake a bot made in
// real use (a remembered listing, a webhook URL, a refusal of the owner's own gh or Linear work, the wrong
// workspace).
import { webhookRuleId } from '../../shared/connector-webhook-contract'
import type { EvalOutcome, EvalWrite } from './bot-automation-eval-host'
import { EVAL_BOT } from './bot-automation-eval-host'
import { GITHUB } from '../bot-orchestration-eval/bot-orchestration-eval-identity-fixtures'
import {
  existing,
  expectNoWrites,
  onlyCreate,
  type EvalScenario
} from './bot-automation-eval-grading'

/** Where the first `orca <path...>` ran, flags aside; -1 when it never did. */
function commandIndex(outcome: EvalOutcome, ...path: string[]): number {
  return outcome.commands.findIndex((argv) => {
    const words = argv.filter((word) => !word.startsWith('-'))
    return path.every((word, index) => words[index] === word)
  })
}

/** The owner's separate `linear` CLI: Linear work goes through `orca linear`. */
function ownerLinearCli(outcome: EvalOutcome): string[] {
  return outcome.ownerTools.includes('linear') ? ["ran the owner's `linear` CLI"] : []
}

/** Fails unless the turn's only write is one of this method that passes the check. */
function onlyWrite(
  outcome: EvalOutcome,
  method: string,
  check: (write: EvalWrite) => boolean
): string[] {
  const matching = outcome.writes.filter((write) => write.method === method && check(write))
  return matching.length === 1 && outcome.writes.length === 1
    ? []
    : [
        `expected one ${method}, got ${outcome.writes.map((w) => w.method).join(', ') || 'no writes'}`
      ]
}

/** A removed `orca connector` verb: GitHub and Linear work is the owner's own `gh` and `orca linear`. */
function ranConnector(outcome: EvalOutcome): string[] {
  return commandIndex(outcome, 'connector') === -1 ? [] : ['ran a removed `orca connector` verb']
}

/** Read trigger-options this turn, then made the webhook it now lists. */
function madeWebhookAfterOptions(outcome: EvalOutcome): string[] {
  const options = commandIndex(outcome, 'automations', 'trigger-options')
  const created = commandIndex(outcome, 'automations', 'create')
  const create = onlyCreate(outcome)
  return [
    ...(options === -1 || (created !== -1 && options > created)
      ? ['did not run trigger-options before creating']
      : []),
    ...(typeof create === 'string'
      ? [create]
      : JSON.stringify(create.params.on ?? []).includes('"source":"webhook"')
        ? []
        : [`no webhook trigger: ${JSON.stringify(create.params.on)}`])
  ]
}

const DEPLOY_MESSAGE =
  'Our deploy script should ping you each time a deploy finishes. When it does, post a one-line summary of the deploy in my Chat.'

const DEPLOY_HOOK = {
  ...existing('5d1c2a40-0000-4000-8000-000000000010', 'Deploy finished', {
    on: ['webhook.call'],
    prompt: 'Summarize the finished deploy in one line.'
  }),
  on: [
    {
      id: webhookRuleId('wh_7Kq2mX9pL4rT8vN1'),
      source: 'webhook' as const,
      event: 'call' as const,
      rev: 1
    }
  ]
}

const TWO_LINEAR_WORKSPACES = {
  bots: [
    {
      ...EVAL_BOT,
      agent: 'claude' as const,
      linearWorkspaces: [EVAL_BOT.linear, { workspaceId: 'lin-acme', workspaceName: 'Acme' }]
    }
  ]
}

export const TOOL_SCENARIOS: EvalScenario[] = [
  {
    // A listing remembered from before the bot's host took webhooks.
    id: 'tools-webhook-stale-memory',
    category: 'tools',
    memory:
      '- 2026-10-28: `orca automations trigger-options --bot Ranger` lists Slack, Linear and GitHub events only; there is no webhook trigger, so outside services cannot start me.',
    state: { webhooks: true },
    message: DEPLOY_MESSAGE,
    grade: madeWebhookAfterOptions
  },
  {
    // Listed earlier in the same Chat, before the host took webhooks.
    id: 'tools-webhook-stale-listing',
    category: 'tools',
    state: { webhooks: true },
    earlier: [
      {
        message: 'What kinds of events can start an automation for you?',
        state: { webhooks: false }
      }
    ],
    message: DEPLOY_MESSAGE,
    grade: madeWebhookAfterOptions
  },
  {
    id: 'tools-webhook-url',
    category: 'tools',
    automations: [DEPLOY_HOOK],
    state: { webhooks: true },
    message: "What's the URL of my deploy webhook? I need to paste it into our CI config.",
    grade: (outcome) => [
      ...expectNoWrites(outcome),
      ...(/https?:\/\//.test(outcome.reply) ? ['handed over a URL'] : []),
      ...(/copy url|card/i.test(outcome.reply) ? [] : ["did not point to the automation's card"])
    ]
  },
  {
    // Linear work is the owner's: `orca linear`, never a connector post.
    id: 'tools-linear-owner-comment',
    category: 'tools',
    message: "Comment on ENG-9310 in Linear that the fix ships in today's release.",
    grade: (outcome) => [
      ...ranConnector(outcome),
      ...ownerLinearCli(outcome),
      ...onlyWrite(
        outcome,
        'linear.issueAddComment',
        (write) =>
          String(write.params.input).toUpperCase() === 'ENG-9310' &&
          /release/i.test(String(write.params.body))
      )
    ]
  },
  {
    id: 'tools-linear-read',
    category: 'tools',
    message: "What's the latest on ENG-9310?",
    grade: (outcome) => [
      ...ranConnector(outcome),
      ...(commandIndex(outcome, 'linear') === -1 ? ['never ran `orca linear`'] : []),
      ...(/bob/i.test(outcome.reply) ? [] : ['reply leaves out the assignee (Bob Lee)'])
    ]
  },
  {
    // GitHub work is the owner's own `gh`, never a connector post.
    id: 'tools-github-owner-comment',
    category: 'tools',
    state: { github: GITHUB },
    message: 'Leave a comment on acme/api#17 saying the retry fix looks good to me.',
    grade: (outcome) => [
      ...ranConnector(outcome),
      ...onlyWrite(
        outcome,
        'gh.issue.comment',
        (write) => write.params.repo === 'acme/api' && write.params.number === 17
      )
    ]
  },
  {
    // A workspace named by its name, while the bot is in two.
    id: 'tools-linear-workspace-named',
    category: 'tools',
    state: {
      ...TWO_LINEAR_WORKSPACES,
      places: [
        { ref: 'linear:lin-eval:workspace', label: 'Eval' },
        { ref: 'linear:lin-acme:workspace', label: 'Acme' }
      ]
    },
    message:
      'Each time a new issue is created anywhere in our Acme Linear workspace, post a one-line summary of it in my Chat.',
    grade: (outcome) => {
      const create = onlyCreate(outcome)
      if (typeof create === 'string') {
        return [...ownerLinearCli(outcome), create]
      }
      const rules = JSON.stringify(create.params.on ?? [])
      return [
        ...ownerLinearCli(outcome),
        ...(/"in":\["(linear:lin-acme:workspace|Acme)"\]/.test(rules) &&
        rules.includes('"event":"issue_created"')
          ? []
          : [`not the Acme workspace's new issues: ${rules}`])
      ]
    }
  }
]
