// What a bot should do with each plain-English request: schedules, where results go, when to ask
// or do nothing, and edits; event triggers are in their own file.
import {
  isConnectorTrigger,
  type AutomationEventTrigger
} from '../../shared/automation-event-triggers'
import { nextAutomationOccurrenceAfter } from '../../shared/automations/scheduling/automation-schedule-occurrences'
import { EVENT_SCENARIOS } from './bot-automation-eval-event-scenarios'
import { TOOL_SCENARIOS } from './bot-automation-eval-tool-scenarios'
import { DELIVERY_SCENARIOS } from './bot-automation-eval-delivery-scenarios'
import { THREAD_MUTE_SCENARIOS } from './bot-automation-eval-thread-mute-scenarios'
import {
  DEPLOY_PINGS,
  EVERY_DAY,
  ISSUE_TRIAGE,
  MORNING_SUMMARY,
  WEEKDAYS,
  expectCreate,
  expectEdit,
  expectNoWrites,
  expectQuestion,
  formatTrigger,
  gradeSchedule,
  gradeTriggers,
  onlyCreate,
  type EvalScenario
} from './bot-automation-eval-grading'

export const EVAL_SCENARIOS: EvalScenario[] = [
  ...EVENT_SCENARIOS,
  ...TOOL_SCENARIOS,
  ...DELIVERY_SCENARIOS,
  ...THREAD_MUTE_SCENARIOS,
  {
    id: 'schedule-weekdays',
    category: 'schedule',
    message: 'Every weekday at 9am, summarize my open pull requests.',
    grade: expectCreate({ schedule: { hour: 9, minute: 0, days: WEEKDAYS } })
  },
  {
    id: 'schedule-hourly',
    category: 'schedule',
    message:
      'Every hour, check that https://staging.example.com/health returns OK and tell me only if it does not.',
    grade: (outcome) => {
      const create = onlyCreate(outcome)
      if (typeof create === 'string') {
        return [create]
      }
      return /FREQ=HOURLY|^\d+ \* \* \* \*$/.test(String(create.params.rrule))
        ? []
        : [`schedule ${String(create.params.rrule)}`]
    }
  },
  {
    id: 'schedule-weekly',
    category: 'schedule',
    message: "Every Monday at 8:30am, write up last week's merged pull requests for me.",
    grade: expectCreate({ schedule: { hour: 8, minute: 30, days: [1] } })
  },
  {
    id: 'schedule-timezone',
    category: 'schedule',
    message: 'Every day at 9am London time, summarize the overnight CI failures for me.',
    grade: (outcome) => {
      const create = onlyCreate(outcome)
      if (typeof create === 'string') {
        return [create]
      }
      // A desktop reads its own clock unless --timezone named a zone; a run at each candidate hour
      // that checks the clock itself is fine too.
      const { rrule, dtstart, timezone, timezoneExplicit } = create.params
      const zone = timezoneExplicit === true ? String(timezone) : undefined
      const london = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
      })
      const times: string[] = []
      for (let after = Date.now(); times.length < 48; after += 60_000) {
        after = nextAutomationOccurrenceAfter(String(rrule), Number(dtstart), after, zone)
        times.push(london.format(after))
      }
      return times.includes('09:00')
        ? []
        : [`runs at ${times.join(', ')} London time (${String(rrule)})`]
    }
  },
  {
    id: 'schedule-every-15-minutes',
    category: 'schedule',
    message:
      'Every 15 minutes, check whether https://docs.example.com is up and tell me only if it is down.',
    grade: (outcome) => {
      const create = onlyCreate(outcome)
      if (typeof create === 'string') {
        return [create]
      }
      const { rrule, dtstart } = create.params
      const first = nextAutomationOccurrenceAfter(String(rrule), Number(dtstart), Date.now())
      const second = nextAutomationOccurrenceAfter(String(rrule), Number(dtstart), first + 60_000)
      return second - first === 15 * 60_000 ? [] : [`schedule ${String(rrule)}`]
    }
  },
  {
    id: 'results-to-channel',
    category: 'results-to',
    message:
      "Every Friday at 5pm, write this week's team status and post it in Slack channel C0TEAM00001.",
    grade: expectCreate({
      schedule: { hour: 17, minute: 0, days: [5] },
      resultsTo: { channel: 'C0TEAM00001' }
    })
  },
  {
    id: 'results-to-none',
    category: 'results-to',
    message:
      "Every night at 11pm, delete my merged local branches. Don't send me anything about it.",
    grade: expectCreate({ schedule: { hour: 23, minute: 0, days: EVERY_DAY }, resultsTo: 'none' })
  },
  {
    id: 'results-to-linear',
    category: 'results-to',
    message:
      'Each weekday at 10am, check the CI status of the pull request linked to ENG-42 and post the update as a comment on ENG-42.',
    grade: expectCreate({
      schedule: { hour: 10, minute: 0, days: WEEKDAYS },
      resultsTo: { linearIssue: 'ENG-42' }
    })
  },
  {
    id: 'ask-orca-by-name',
    category: 'ask',
    message: "each time someone pings me in #orca, if it's a bug or ticket, start an agent on it",
    grade: expectQuestion(/channel/i)
  },
  {
    id: 'ask-email',
    category: 'ask',
    message: 'Whenever I get an email from my manager, summarize it for me.',
    grade: (outcome) => [
      ...expectNoWrites(outcome),
      ...(/email/i.test(outcome.reply) ? [] : ['reply does not mention email'])
    ]
  },
  {
    id: 'ask-discord',
    category: 'ask',
    message: 'When someone posts in our Discord #support channel, answer them.',
    grade: (outcome) => [
      ...expectNoWrites(outcome),
      ...(/discord/i.test(outcome.reply) ? [] : ['reply does not mention Discord'])
    ]
  },
  {
    id: 'ask-linear-comment',
    category: 'ask',
    // Linear has no comment event, only a mention of the owner.
    message: 'Whenever anyone comments on ENG-77 in Linear, summarize the comment for me.',
    grade: (outcome) => [
      ...expectNoWrites(outcome),
      ...(/comment/i.test(outcome.reply) ? [] : ['reply does not mention comments'])
    ]
  },
  {
    id: 'ask-github-release',
    category: 'ask',
    message: 'When a new release is published in stablyai/orca, write release notes for the blog.',
    grade: (outcome) => [
      ...expectNoWrites(outcome),
      ...(/release/i.test(outcome.reply) ? [] : ['reply does not mention releases'])
    ]
  },
  {
    id: 'ask-no-source',
    category: 'ask',
    message: 'Whenever a customer complains, let me know.',
    grade: expectQuestion(/./)
  },
  {
    id: 'no-automation-bot-mentioned',
    category: 'no-automation',
    // Mentioning the bot already starts a conversation with it; no automation is needed.
    message: 'When people @mention you in Slack, answer their questions.',
    grade: expectNoWrites
  },
  {
    id: 'no-automation-check-now',
    category: 'no-automation',
    message: 'What automations do I have set up right now?',
    grade: (outcome) => [
      ...expectNoWrites(outcome),
      ...(/deploy pings/i.test(outcome.reply) ? [] : ['did not list them'])
    ],
    automations: [DEPLOY_PINGS]
  },
  {
    id: 'no-automation-question',
    category: 'no-automation',
    message: 'Can automations start when someone reacts to a Slack message?',
    grade: expectNoWrites
  },
  {
    id: 'edit-add-channel',
    category: 'edit',
    message: 'Have the deploy pings automation also listen in Slack channel C0456EFGH.',
    automations: [DEPLOY_PINGS, MORNING_SUMMARY],
    grade: expectEdit(DEPLOY_PINGS.id, (updates) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real CLI parsed each --on.
      const on = (updates.on ?? []) as AutomationEventTrigger[]
      const channels = new Set(
        on.flatMap((trigger) => (isConnectorTrigger(trigger) ? (trigger.in ?? []) : []))
      )
      return [
        ...(channels.has('C0123ABCD') && channels.has('C0456EFGH')
          ? []
          : [`channels ${[...channels].join(',') || 'none'}`]),
        ...on
          .filter(
            (trigger) =>
              trigger.event !== 'mentioned' || !/deploy/i.test(trigger.textContains ?? '')
          )
          .map((trigger) => `changed trigger ${formatTrigger(trigger)}`)
      ]
    })
  },
  {
    id: 'edit-reschedule',
    category: 'edit',
    message: 'Move my morning PR summary to 8:30.',
    automations: [DEPLOY_PINGS, MORNING_SUMMARY],
    grade: expectEdit(MORNING_SUMMARY.id, (updates) =>
      gradeSchedule(updates.rrule, updates.dtstart, { hour: 8, minute: 30, days: EVERY_DAY })
    )
  },
  {
    id: 'edit-pause',
    category: 'edit',
    message: 'Pause the deploy pings automation for now; I may want it back later.',
    automations: [DEPLOY_PINGS, MORNING_SUMMARY],
    grade: expectEdit(DEPLOY_PINGS.id, (updates) =>
      updates.enabled === false ? [] : [`updates ${JSON.stringify(updates)}`]
    )
  },
  {
    id: 'edit-remove',
    category: 'edit',
    message: "Delete the morning PR summary automation, I don't need it anymore.",
    automations: [DEPLOY_PINGS, MORNING_SUMMARY],
    grade: (outcome) =>
      outcome.writes.length === 1 &&
      outcome.writes[0]!.method === 'automation.delete' &&
      outcome.writes[0]!.params.id === MORNING_SUMMARY.id
        ? []
        : [
            `writes ${JSON.stringify(outcome.writes.map((write) => [write.method, write.params.id]))}`
          ]
  },
  {
    id: 'edit-narrow-repo',
    category: 'edit',
    message: 'Make my issue triage automation only run for stablyai/orca.',
    automations: [ISSUE_TRIAGE],
    grade: expectEdit(ISSUE_TRIAGE.id, (updates) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real CLI parsed each --on.
      gradeTriggers(updates.on as AutomationEventTrigger[] | undefined, [
        { on: 'github.issue_opened', in: ['stablyai/orca'] }
      ])
    )
  }
]
