// The owner's workspaces a new bot finds on its first look (bots adopting existing workspaces): long-lived
// ones whose names no longer say what their agents do, several on one area, one on an SSH host, and one
// another bot already owns.
import { ORCA_REPO } from './bot-orchestration-eval-fixtures'
import { DAY, HOUR, MINUTE, type AdoptionFixture } from './bot-orchestration-eval-adoption-rows'

export const ML_REPO = '5e1f0c2a-7d4b-4c1e-9a8f-2b6d3e4f5a61'

// Named "webhooks" for the first thing it did; its PR merged long ago and its agent has done bots work since.
export const WEBHOOKS: AdoptionFixture = {
  repoId: ORCA_REPO,
  repo: 'orca',
  name: 'webhooks',
  branch: 'alice/headless-automation-sleep-per-run',
  ago: 25 * MINUTE,
  pr: {
    number: 29811,
    state: 'merged',
    title: 'Sleep headless automation runs between turns',
    checks: 'success'
  },
  agents: [
    {
      handle: 'term_webhooks',
      state: 'done',
      ago: 25 * MINUTE,
      asked:
        'the bot row should list a workspace the bot took over, and give it a Remove from <bot> item',
      said: "Pushed 4c1e2aa to #388 (bots: take over workspaces you already have). Nora approved it; the signed macOS build (run 2) is still going. I'll merge once it's green unless you want another look.",
      earlier: [
        {
          asked: "the new bot's first message should say which CLI it runs as",
          said: 'Done: the greeting now names Claude Code or Codex. Merged in #371.'
        },
        {
          asked:
            "when a bot needs Slack and doesn't have it, show a Connect card instead of telling them where to click",
          said: 'Added `orca bot connectors --offer`; the card turns to Connected once linked. #379 merged.'
        }
      ]
    }
  ],
  commits: [
    { message: 'Sleep headless automation runs between turns (#29811)', ago: 13 * DAY },
    { message: 'bots: greeting names the CLI the bot runs as (#371)', ago: 5 * DAY },
    { message: 'bots: Connect card for a connector a bot needs (#379)', ago: 3 * DAY },
    { message: 'bots: take over workspaces you already have', ago: 6 * HOUR },
    { message: 'bots: Remove from <bot> on a taken-over workspace', ago: 40 * MINUTE }
  ]
}

const AUTOMATIONS_IMPROVE: AdoptionFixture = {
  repoId: ORCA_REPO,
  repo: 'orca',
  name: 'automations-improve',
  ago: 15 * MINUTE,
  pr: {
    number: 30410,
    state: 'open',
    title: 'Automations: retry a failed run once',
    checks: 'pending'
  },
  agents: [
    {
      handle: 'term_auto_improve',
      agent: 'codex',
      state: 'working',
      ago: 4 * MINUTE,
      asked: 'a scheduled automation run that fails should retry once with a backoff',
      said: 'Retry with a 30s backoff is in. Adding a test for the missed-run grace window now.'
    }
  ],
  commits: [
    { message: 'automations: retry a failed run once', ago: 2 * HOUR },
    { message: 'automations: test the missed-run grace window', ago: 20 * MINUTE }
  ]
}

const AUTOMATION_RESULTS: AdoptionFixture = {
  repoId: ORCA_REPO,
  repo: 'orca',
  name: 'automation-results-design',
  branch: 'automation-results-dev-preview',
  ago: 2 * HOUR,
  pr: { number: 30398, state: 'open', title: 'Automation result cards', checks: 'success' },
  agents: [
    {
      handle: 'term_auto_results',
      state: 'done',
      ago: 2 * HOUR,
      asked: "make the automation result card show the run's summary and a link to its chat",
      said: "Result cards now show the run's summary and an Open chat link. #30398 is green and waiting on your review."
    }
  ],
  commits: [{ message: 'automations: result card with summary and chat link', ago: 3 * HOUR }]
}

const CRON_PREVIEW: AdoptionFixture = {
  repoId: ORCA_REPO,
  repo: 'orca',
  name: 'cron-preview',
  branch: 'alice/schedule-next-runs',
  ago: 50 * MINUTE,
  agents: [
    {
      handle: 'term_cron_preview',
      state: 'waiting',
      ago: 50 * MINUTE,
      asked: 'show the next 3 times an automation will run under its schedule picker',
      said: "The preview works. One question before I finish: when the bot's timezone differs from yours, should the times show in the bot's timezone or yours?"
    }
  ]
}

const TRIGGER_COPY: AdoptionFixture = {
  repoId: ORCA_REPO,
  repo: 'orca',
  name: 'trigger-options-copy',
  branch: 'trigger-options-plain-words',
  ago: 5 * HOUR,
  pr: {
    number: 30415,
    state: 'open',
    title: 'automations trigger-options in plain words',
    checks: 'success'
  },
  agents: [
    {
      handle: 'term_trigger_copy',
      state: 'done',
      ago: 5 * HOUR,
      asked: 'rewrite `orca automations trigger-options` so each trigger reads in plain words',
      said: 'trigger-options now prints lines like "When someone mentions you in #channel". #30415 is green.'
    }
  ]
}

// Automations work too, but its agent is closed: nothing to hand off, so never on a card.
const AUTOMATION_DOCS: AdoptionFixture = {
  repoId: ORCA_REPO,
  repo: 'orca',
  name: 'automation-docs',
  branch: 'docs/automations-guide',
  ago: 3 * HOUR,
  pr: {
    number: 30402,
    state: 'open',
    title: 'docs: automations guide',
    checks: 'success'
  },
  commits: [{ message: 'docs: automations guide', ago: 3 * HOUR }]
}

export const AUTOMATION_FIXTURES = [
  AUTOMATIONS_IMPROVE,
  AUTOMATION_RESULTS,
  CRON_PREVIEW,
  TRIGGER_COPY
]

const GPU_LOADER: AdoptionFixture = {
  repoId: ML_REPO,
  repo: 'ml-pipeline',
  name: 'gpu-loader-oom',
  branch: 'fix-loader-oom',
  host: 'ssh:gpu-box',
  ago: 30 * MINUTE,
  agents: [
    {
      handle: 'term_gpu_loader',
      state: 'working',
      ago: 6 * MINUTE,
      asked: 'the dataloader runs out of memory at batch size 512 on the A100 box; find out why',
      said: 'Peak memory is the pinned host buffers, not the model. Trying prefetch_factor=2 and measuring again.'
    }
  ]
}

// Its PR merged nine days ago; its agent has moved on to terminal search since.
const SIDEBAR_PERF: AdoptionFixture = {
  repoId: ORCA_REPO,
  repo: 'orca',
  name: 'sidebar-perf',
  ago: 10 * MINUTE,
  pr: {
    number: 30122,
    state: 'merged',
    title: 'Sidebar: skip re-render on worktree switch',
    checks: 'success'
  },
  agents: [
    {
      handle: 'term_sidebar_perf',
      state: 'working',
      ago: 3 * MINUTE,
      asked:
        'now make Cmd+F in the terminal search the whole scrollback, not just what is on screen',
      said: 'Search now walks the scrollback buffer; 2 of 14 tests still fail on wrapped lines. Fixing how wrapped lines join next, then I will open the PR.',
      earlier: [
        {
          asked:
            'the find bar should highlight every match in the terminal, not only the current one',
          said: 'All matches are highlighted now; the current one is outlined. Pushed to the branch, no PR yet.'
        }
      ]
    }
  ],
  commits: [
    { message: 'sidebar: skip re-render on worktree switch (#30122)', ago: 9 * DAY },
    { message: 'terminal: highlight every find match', ago: 2 * DAY },
    { message: 'terminal: find searches the scrollback buffer (wip)', ago: 3 * HOUR }
  ]
}

// Another bot's already: actionable, so only ownership keeps it out of an offer.
const RELEASE: AdoptionFixture = {
  repoId: ORCA_REPO,
  repo: 'orca',
  name: 'release-1.4.231',
  branch: 'release/1.4.231',
  ago: 35 * MINUTE,
  bot: 'Shipper',
  pr: { number: 30420, state: 'open', title: 'Release 1.4.231', checks: 'success' },
  agents: [
    {
      handle: 'term_release',
      state: 'done',
      ago: 35 * MINUTE,
      asked: 'cut the 1.4.231 RC and draft the release notes',
      said: 'RC build 3 is green and the notes draft is in RELEASE_NOTES.md. Waiting on your go to publish.'
    }
  ]
}

// Bots work no bot owns yet, while Atlas exists for exactly that.
const SLACK_THREADS: AdoptionFixture = {
  repoId: ORCA_REPO,
  repo: 'orca',
  name: 'slack-thread-replies',
  branch: 'bots/slack-thread-replies',
  ago: 40 * MINUTE,
  pr: {
    number: 30431,
    state: 'open',
    title: 'bots: reply in the Slack thread that mentioned the bot',
    checks: 'success'
  },
  agents: [
    {
      handle: 'term_slack_threads',
      state: 'done',
      ago: 40 * MINUTE,
      asked:
        'a bot should reply in the Slack thread it was mentioned in, not at the top of the channel',
      said: 'Replies now go to the thread (thread_ts) with a test. #30431 is green and waiting on review.'
    }
  ]
}

// The owner's coordinator: named for its first task, its own exchanges about something else, while the
// workspaces its agent started all work on bot tools.
const COORDINATOR: AdoptionFixture = {
  repoId: ORCA_REPO,
  repo: 'orca',
  name: 'nightly-cleanup',
  branch: 'alice/nightly-cleanup',
  ago: 10 * MINUTE,
  pr: { number: 29640, state: 'merged', title: 'Clean up nightly build logs', checks: 'success' },
  agents: [
    {
      handle: 'term_coordinator',
      state: 'done',
      ago: 10 * MINUTE,
      asked: 'how are things going?',
      said: 'All three workers are still running; nothing needs you yet. I will check back in 20 minutes.'
    }
  ]
}

const coordinated = (name: string, asked: string, said: string): AdoptionFixture => ({
  repoId: ORCA_REPO,
  repo: 'orca',
  name,
  parent: COORDINATOR.name,
  ago: 15 * MINUTE,
  agents: [{ handle: `term_${name}`, state: 'working', ago: 5 * MINUTE, asked, said }]
})

export const COORDINATED_FIXTURES = [
  COORDINATOR,
  coordinated(
    'tool-templates-research',
    'research starter templates a new bot could pick its MCP tools from',
    'Drafted 6 tool templates (GitHub, Linear, Sentry, Notion, Postgres, Figma); checking which need a sign-in.'
  ),
  coordinated(
    'mcp-details-panel',
    "show each of a bot's MCP tools with its URL or command and whether it needs a sign-in",
    'The details panel lists each tool; wiring the Edit button to `orca bot tools add` next.'
  ),
  coordinated(
    'tool-signin-flow',
    'let the owner sign a bot in to an MCP tool that uses OAuth, from the bot settings',
    'OAuth sign-in works for Notion; Sentry returns a scope error I am looking into.'
  )
]

export const FIXTURES = {
  WEBHOOKS,
  AUTOMATION_DOCS,
  GPU_LOADER,
  SIDEBAR_PERF,
  RELEASE,
  SLACK_THREADS
}
