// The world around the bots-adoption scenarios' workspaces: the clutter every owner has, their open pull
// requests on GitHub, and the other bots already set up.
import type { EvalHostState } from '../bot-automation-eval/bot-automation-eval-host'
import type { EvalGithubThread } from '../bot-automation-eval/bot-automation-eval-gh-world'
import type { StandInBot } from './bot-orchestration-eval-bots'
import { GITHUB } from './bot-orchestration-eval-identity-fixtures'
import { CLOUD_REPO, ORCA_REPO, PROJECTS } from './bot-orchestration-eval-fixtures'
import {
  adoptionRow,
  adoptionTranscripts,
  DAY,
  type AdoptionFixture
} from './bot-orchestration-eval-adoption-rows'
import { ML_REPO } from './bot-orchestration-eval-adoption-fixtures'

// Clutter every world has: agents closed, or idle on throwaway questions, or older than a week.
const CLUTTER: AdoptionFixture[] = [
  {
    repoId: ORCA_REPO,
    repo: 'orca',
    name: 'mobile-ota',
    ago: 3 * DAY,
    pr: { number: 30048, state: 'merged', title: 'Mobile: OTA update channel', checks: 'success' }
  },
  {
    repoId: CLOUD_REPO,
    repo: 'api',
    name: 'relay-drain-metrics',
    ago: 4 * DAY,
    pr: { number: 612, state: 'merged', title: 'Relay: drain duration metrics', checks: 'success' }
  },
  {
    repoId: ORCA_REPO,
    repo: 'orca',
    name: 'regex-question',
    ago: 2 * DAY,
    agents: [
      {
        handle: 'term_regex',
        state: 'done',
        ago: 2 * DAY,
        asked: 'what does ^(?:[a-z]+-)*[a-z]+$ match?',
        said: 'Lowercase words joined by single hyphens, like "foo-bar-baz"; no leading, trailing or double hyphens.'
      }
    ]
  },
  {
    repoId: CLOUD_REPO,
    repo: 'api',
    name: 'read-terraform',
    ago: 3 * DAY,
    agents: [
      {
        handle: 'term_terraform',
        state: 'done',
        ago: 3 * DAY,
        asked: 'explain what the relay module in infra/terraform creates',
        said: 'It creates one managed instance group per cell, a regional load balancer and the Cloud SQL proxy sidecar. Nothing to change.'
      }
    ]
  },
  ...Array.from({ length: 12 }, (_, index): AdoptionFixture => ({
    repoId: ORCA_REPO,
    repo: 'orca',
    name: `old-task-${index + 1}`,
    ago: (10 + index * 2) * DAY,
    pr: {
      number: 29000 + index,
      state: 'merged',
      title: `Old task ${index + 1}`,
      checks: 'success'
    }
  }))
]

const PULLS: EvalGithubThread[] = [
  {
    number: 388,
    title: 'bots: take over workspaces you already have',
    body: 'A bot can take over a workspace its owner hands it: the workspace moves under the bot row and its agent becomes a worker.',
    author: 'alice-h',
    state: 'OPEN',
    comments: [{ author: 'nora-park', body: 'Approved. Ship it once the macOS build is green.' }],
    pull: {
      head: 'alice/headless-automation-sleep-per-run',
      base: 'main',
      diff: '',
      checks: [
        { name: 'verify', state: 'pass' },
        { name: 'macos-signed-build', state: 'pending' }
      ]
    }
  },
  {
    number: 30410,
    title: 'Automations: retry a failed run once',
    body: 'A failed scheduled run retries once after 30s.',
    author: 'alice-h',
    state: 'OPEN',
    pull: {
      head: 'automations-improve',
      base: 'main',
      diff: '',
      checks: [{ name: 'verify', state: 'pending' }]
    }
  },
  {
    number: 30398,
    title: 'Automation result cards',
    body: "Result cards show the run's summary and an Open chat link.",
    author: 'alice-h',
    state: 'OPEN',
    pull: {
      head: 'automation-results-dev-preview',
      base: 'main',
      diff: '',
      checks: [{ name: 'verify', state: 'pass' }]
    }
  },
  {
    number: 30415,
    title: 'automations trigger-options in plain words',
    body: 'Each trigger reads as a sentence.',
    author: 'alice-h',
    state: 'OPEN',
    pull: {
      head: 'trigger-options-plain-words',
      base: 'main',
      diff: '',
      checks: [{ name: 'verify', state: 'pass' }]
    }
  },
  {
    number: 30431,
    title: 'bots: reply in the Slack thread that mentioned the bot',
    body: 'Replies go to thread_ts.',
    author: 'alice-h',
    state: 'OPEN',
    pull: {
      head: 'bots/slack-thread-replies',
      base: 'main',
      diff: '',
      checks: [{ name: 'verify', state: 'pass' }]
    }
  }
]

const ADOPTION_GITHUB = {
  repos: GITHUB.repos.map((repo) =>
    repo.fullName === 'stablyai/orca' ? { ...repo, threads: [...repo.threads, ...PULLS] } : repo
  )
}

const PROJECTS_WITH_ML = [
  ...PROJECTS,
  { id: ML_REPO, displayName: 'ml-pipeline', path: '/home/owner/ml-pipeline' }
]

/** A world of these workspaces (clutter always included). */
export function adoptionWorld(fixtures: AdoptionFixture[]): Partial<EvalHostState> {
  const all = [...fixtures, ...CLUTTER]
  return {
    repos: PROJECTS_WITH_ML,
    github: ADOPTION_GITHUB,
    worktrees: all.map((fixture) => adoptionRow(fixture, all)),
    terminalTranscripts: adoptionTranscripts(all)
  }
}

/** A fixture's workspace id, as offers and hand-offs name it. */
export function idOf(fixture: AdoptionFixture): string {
  return String(adoptionRow(fixture).worktreeId)
}

/** Atlas owns the bots work; Shipper owns releases. */
export const OTHER_BOTS: StandInBot[] = [
  { id: 'bot-atlas', name: 'Atlas', agent: 'claude', slack: null, github: null, linear: null },
  { id: 'bot-shipper', name: 'Shipper', agent: 'claude', slack: null, github: null, linear: null }
]

export const OTHER_BOT_SOULS: Record<string, string> = {
  'bot-atlas':
    'I own the Orca bots work: the bot runtime, bot chats, connectors (Slack, GitHub, Linear) and the bots sidebar.\n\n## How I work\nShip small PRs and keep CI green.\n\n## Never\nMerge without a green build.',
  'bot-shipper':
    'I cut and publish Orca desktop releases: RCs, release notes and the publish step.\n\n## How I work\nOne release at a time.\n\n## Never\nPublish without the owner saying go.'
}
