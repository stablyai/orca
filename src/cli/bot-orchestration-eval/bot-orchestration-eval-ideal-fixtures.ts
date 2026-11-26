// The worlds the plan's ideal interactions play out in: a flaky export test whose worker opened a
// pull request, an empty-state task, and a repository the bot has no GitHub connector for. Work the
// bot started is in Orca's work record; GitHub's answers about its pull request are fixtures.
import { EVAL_BOT, type EvalHostState } from '../bot-automation-eval/bot-automation-eval-host'
import type { CheckStatus } from '../../shared/github/pull-requests/pull-request-types'
import {
  EMPTY_WORLD,
  ORCA_REPO,
  OWNER_WORKSPACES,
  PROJECTS,
  runningWorker,
  workerDone,
  workspace
} from './bot-orchestration-eval-fixtures'

type World = Partial<EvalHostState>

const ORCA_GITHUB = { id: 900001, fullName: 'stablyai/orca' }
const ACME_SITE_REPO = '0b6f2c1e-6d0e-4f5c-9a51-2f7c3b8e9d10'
const EXPORT_HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

/** A Slack thread the export work came from. */
const EXPORT_THREAD = { source: 'slack' as const, title: 'export test flaking again' }

export const EXPORT_FIX =
  'the export retry test in orca keeps flaking on CI, can you get it sorted?'
export const EXPORT_DONE = workerDone(
  'ctx_w1',
  'Fixed the flaky export retry test: it waited on a 500 ms timer instead of the export finishing. It now awaits the export. 100/100 local runs pass. Opened PR https://github.com/stablyai/orca/pull/36700; checks are running.'
)

const EXPORT_WORKSPACE = workspace({
  repoId: ORCA_REPO,
  repo: 'orca',
  name: 'fix-flaky-export-test',
  state: 'done',
  byBot: true,
  prompt: 'Fix the flaky export retry test.',
  last: 'Opened PR #36700.'
})

// The lint failure the CI wake reports; the status world has it green again.
const EXPORT_CHECKS: CheckStatus = 'failure'

const EXPORT_PR = {
  number: 36700,
  url: 'https://github.com/stablyai/orca/pull/36700',
  state: 'open' as const,
  checks: EXPORT_CHECKS,
  review: null,
  headSha: EXPORT_HEAD
}

/** A new Slack thread with the bot: no work yet. */
export const THREAD_WORLD: World = { ...EMPTY_WORLD, conversation: EXPORT_THREAD }

/** The export worker reported its PR and closed on its own; the thread's record names it. */
export const FINISHED_EXPORT_WORLD: World = {
  ...EMPTY_WORLD,
  conversation: EXPORT_THREAD,
  githubRepos: { [ORCA_REPO]: ORCA_GITHUB },
  worktrees: [EXPORT_WORKSPACE],
  pulls: { [String(EXPORT_WORKSPACE.worktreeId)]: EXPORT_PR },
  workers: [
    {
      ...runningWorker(EXPORT_WORKSPACE.worktreeId, 'Fix the flaky export retry test.'),
      state: 'succeeded',
      terminal: 'released'
    }
  ],
  recorded: [
    { dispatchId: 'ctx_w1', source: 'slack', externalId: 'eval-thread', title: EXPORT_THREAD.title }
  ]
}

const EMPTY_STATE_WORKSPACE = workspace({
  repoId: ORCA_REPO,
  repo: 'orca',
  name: 'eng-9201-empty-state',
  state: 'working',
  byBot: true,
  prompt: 'ENG-9201: build the empty state for the exports page.',
  last: 'Added the illustration; wiring the "New export" button.'
})

const EMPTY_STATE_SPEC = 'ENG-9201: build the empty state for the exports page.'

/** The ENG-9201 issue thread, whose worker is still running. */
export const EMPTY_STATE_WORLD: World = {
  ...EMPTY_WORLD,
  conversation: { source: 'linear', title: 'ENG-9201 Exports page empty state' },
  worktrees: [EMPTY_STATE_WORKSPACE],
  workers: [runningWorker(EMPTY_STATE_WORKSPACE.worktreeId, EMPTY_STATE_SPEC)],
  recorded: [
    {
      dispatchId: 'ctx_w1',
      source: 'linear',
      externalId: 'eval-thread',
      title: 'ENG-9201 Exports page empty state'
    }
  ]
}

/** The owner's DM: the bot's two pieces of work, beside every workspace the owner has. */
export const STATUS_WORLD: World = {
  ...FINISHED_EXPORT_WORLD,
  conversation: undefined,
  pulls: { [String(EXPORT_WORKSPACE.worktreeId)]: { ...EXPORT_PR, checks: 'success' } },
  worktrees: [EXPORT_WORKSPACE, EMPTY_STATE_WORKSPACE, ...OWNER_WORKSPACES],
  workers: [
    ...(FINISHED_EXPORT_WORLD.workers ?? []),
    {
      ...runningWorker(EMPTY_STATE_WORKSPACE.worktreeId, EMPTY_STATE_SPEC),
      dispatchId: 'ctx_w2',
      taskId: 'task_2',
      terminalHandle: 'term_w2'
    }
  ],
  recorded: [
    {
      dispatchId: 'ctx_w1',
      source: 'slack',
      externalId: 'export-thread',
      title: EXPORT_THREAD.title
    },
    {
      dispatchId: 'ctx_w2',
      source: 'linear',
      externalId: 'ENG-9201',
      title: 'ENG-9201 Exports page empty state'
    }
  ]
}

const SITE_WORKSPACE = workspace({
  repoId: ACME_SITE_REPO,
  repo: 'site',
  name: 'fix-footer-links',
  state: 'working',
  byBot: true,
  prompt: 'Fix the broken footer links on the pricing page.',
  last: 'Updating the link map.'
})

/** A worker in a repo the bot has no GitHub connector for reports a PR. */
export const NO_GITHUB_WORLD: World = {
  ...EMPTY_WORLD,
  repos: [...PROJECTS, { id: ACME_SITE_REPO, displayName: 'site', path: 'projects/site' }],
  bots: [{ ...EVAL_BOT, agent: 'claude', github: null }],
  worktrees: [SITE_WORKSPACE],
  workers: [
    runningWorker(SITE_WORKSPACE.worktreeId, 'Fix the broken footer links on the pricing page.')
  ]
}

export const SITE_DONE = workerDone(
  'ctx_w1',
  'Fixed the footer links: two pointed at the old /plans page. Opened PR https://github.com/acme/site/pull/812.'
)
