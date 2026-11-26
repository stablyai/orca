// Requests that should become an event trigger: the right source, event and filters.
import {
  EVERY_DAY,
  expectCreate,
  expectNoWrites,
  expectQuestion,
  type EvalScenario
} from './bot-automation-eval-grading'
import { EVAL_BOT } from './bot-automation-eval-host'

// The stand-in's bot with only some connectors set up; the host gives it the run's agent.
function botWith(connectors: { slack?: boolean; github?: boolean; linear?: boolean }) {
  return {
    state: {
      bots: [
        {
          ...EVAL_BOT,
          agent: 'claude' as const,
          slack: connectors.slack ? EVAL_BOT.slack : null,
          github: connectors.github ? EVAL_BOT.github : null,
          linear: connectors.linear ? EVAL_BOT.linear : null
        }
      ]
    }
  }
}

// No automation, at most a Connect card, and the reply names the connector the bot is missing.
function expectMissingConnector(name: RegExp) {
  return (outcome: Parameters<typeof expectNoWrites>[0]): string[] => [
    ...expectNoWrites({
      ...outcome,
      writes: outcome.writes.filter((write) => write.method !== 'bots.connector.offer')
    }),
    ...(name.test(outcome.reply) ? [] : [`reply does not mention ${name}`])
  ]
}

export const EVENT_SCENARIOS: EvalScenario[] = [
  {
    id: 'slack-orca-link',
    category: 'slack',
    // Slack writes a channel it links as <#id|name>; the bot's own mention is stripped.
    message:
      "each time someone pings me in <#C07ORCA0001|orca>, if it's a bug or ticket, start an agent on it",
    grade: expectCreate({
      triggers: [{ on: 'slack.mentioned', in: ['C07ORCA0001'] }],
      prompt: [/bug/i, /ticket/i]
    })
  },
  {
    id: 'slack-orca-bare-link',
    category: 'slack',
    // Newer Slack clients send a linked channel without its name.
    message: 'whenever anyone mentions me in <#C07ORCA0001|>, triage it and tell me what it needs',
    grade: expectCreate({ triggers: [{ on: 'slack.mentioned', in: ['C07ORCA0001'] }] })
  },
  {
    id: 'slack-mention-id',
    category: 'slack',
    message:
      'Whenever someone mentions me in Slack channel C0SUPPORT01, look at what they need and draft an answer for me.',
    grade: expectCreate({ triggers: [{ on: 'slack.mentioned', in: ['C0SUPPORT01'] }] })
  },
  {
    id: 'slack-reaction',
    category: 'slack',
    message:
      'When someone reacts with :eyes: to a message in Slack channel C0DEPLOY012, summarize that thread for me.',
    grade: expectCreate({
      triggers: [{ on: 'slack.reaction', in: ['C0DEPLOY012'], contains: /eyes/ }]
    })
  },
  {
    id: 'slack-this-channel',
    category: 'slack',
    message:
      "from now on, whenever a new message is posted in this channel, check whether it's a billing question and answer it if it is",
    // A Slack-started chat isn't told its channel, so the right move is to ask for it.
    grade: expectQuestion(/channel/i)
  },
  {
    id: 'github-pr-opened',
    category: 'github',
    message: 'Whenever a pull request is opened in stablyai/orca, review it.',
    grade: expectCreate({ triggers: [{ on: 'github.pr_opened', in: ['stablyai/orca'] }] })
  },
  {
    id: 'github-ci-failed',
    category: 'github',
    message: 'If CI fails on any of my repos, look into why and tell me what broke.',
    grade: expectCreate({ triggers: [{ on: 'github.ci_failed' }] })
  },
  {
    id: 'github-review-requested',
    category: 'github',
    message: 'When someone requests my review on GitHub, give me a short summary of the PR.',
    grade: expectCreate({ triggers: [{ on: 'github.review_requested' }] })
  },
  {
    id: 'github-pr-pushed-subject',
    category: 'github',
    message: 'Tell me whenever new commits get pushed to stablyai/orca#482.',
    grade: expectCreate({
      triggers: [{ on: 'github.pr_pushed', subject: 'stablyai/orca#482' }]
    })
  },
  {
    id: 'github-mentioned-repo',
    category: 'github',
    message: "When I'm @-mentioned in a GitHub comment in stablyai/orca, draft a reply for me.",
    grade: expectCreate({ triggers: [{ on: 'github.mentioned', in: ['stablyai/orca'] }] })
  },
  {
    id: 'linear-assigned',
    category: 'linear',
    message: "When I'm assigned a Linear issue, start an agent on it.",
    grade: expectCreate({ triggers: [{ on: 'linear.assigned' }] })
  },
  {
    id: 'linear-created-team',
    category: 'linear',
    message: 'Whenever a new issue is created in our ENG team in Linear, triage it.',
    // Triage's outcome is the issue's own labels and state: nothing to report, or a note on it, is fine.
    grade: expectCreate({
      triggers: [{ on: 'linear.issue_created', in: ['ENG'] }],
      resultsTo: ['chat', 'none', 'thread']
    })
  },
  {
    id: 'linear-moved-subject',
    category: 'linear',
    message: 'Let me know each time ENG-123 changes status.',
    grade: expectCreate({ triggers: [{ on: 'linear.issue_moved', subject: 'ENG-123' }] })
  },
  {
    id: 'mixed-issue-crash',
    category: 'mixed',
    message:
      'When someone opens an issue in stablyai/orca, if it looks like a crash report, try to reproduce it.',
    grade: expectCreate({
      triggers: [{ on: 'github.issue_opened', in: ['stablyai/orca'] }],
      prompt: [/crash/i, /reproduc/i]
    })
  },
  {
    id: 'mixed-urgent-mention',
    category: 'mixed',
    message:
      "When I'm mentioned in Slack channel C0SUPPORT01, if it sounds urgent, start investigating right away; otherwise just note it in your memory.",
    grade: expectCreate({
      triggers: [{ on: 'slack.mentioned', in: ['C0SUPPORT01'] }],
      prompt: [/urgent/i]
    })
  },
  {
    id: 'mixed-schedule-and-event',
    category: 'mixed',
    message:
      'Keep the changelog draft current: update it every day at 6pm, and also right away whenever a pull request is merged in stablyai/orca.',
    // The draft is the outcome: nothing to report, or a note where it happened, is fine.
    grade: expectCreate({
      triggers: [{ on: 'github.pr_merged', in: ['stablyai/orca'] }],
      schedule: { hour: 18, minute: 0, days: EVERY_DAY },
      prompt: [/changelog/i],
      resultsTo: ['chat', 'none', 'thread']
    })
  },
  {
    id: 'filter-contains',
    category: 'filters',
    message:
      'Whenever a message in Slack channel C0DEPLOY012 says "deploy failed", investigate the failure.',
    grade: expectCreate({
      triggers: [{ on: 'slack.message', in: ['C0DEPLOY012'], contains: /^deploy failed$/i }]
    })
  },
  {
    id: 'filter-subject-comments',
    category: 'filters',
    message: 'When anyone leaves feedback on stablyai/orca#900, address it.',
    // Addressing it is the outcome, on the pull request: no report, or one there, is fine.
    grade: expectCreate({
      triggers: [{ on: 'github.comment', subject: 'stablyai/orca#900' }],
      optionalTriggers: [
        { on: 'github.review_comment', subject: 'stablyai/orca#900' },
        { on: 'github.review', subject: 'stablyai/orca#900' }
      ],
      resultsTo: ['chat', 'none', 'thread']
    })
  },
  {
    id: 'filter-two-teams-contains',
    category: 'filters',
    message:
      'Any new Linear issue in the ENG or OPS teams that mentions "outage": page me with a summary.',
    grade: expectCreate({
      triggers: [{ on: 'linear.issue_created', in: ['ENG', 'OPS'], contains: /^outage$/i }]
    })
  },
  {
    // Ideal interaction 8, held out. No event fires on a label: start on new issues and judge the
    // label in the prompt, or say that first and ask.
    id: 'ideal-08-labeled-issue',
    category: 'github',
    message:
      'any time a bug with the export label gets filed in stablyai/orca, have a first look at it',
    grade: (outcome) => {
      const created = expectCreate({
        triggers: [{ on: 'github.issue_opened', in: ['stablyai/orca'] }],
        prompt: [/export/i]
      })(outcome)
      return created.length && expectQuestion(/label/i)(outcome).length ? created : []
    }
  },
  {
    id: 'missing-slack-connector',
    category: 'ask',
    message: 'Whenever someone mentions me in Slack channel C0SUPPORT01, draft an answer for me.',
    ...botWith({ github: true }),
    grade: expectMissingConnector(/slack/i)
  },
  {
    id: 'missing-github-connector',
    category: 'ask',
    message: 'If CI fails on stablyai/orca, look into why and tell me what broke.',
    ...botWith({}),
    grade: expectMissingConnector(/github/i)
  }
]
