// The stand-in world a benchmarked bot hands work off in: an owner's projects, as cluttered as real
// ones get, their workspaces and agents, one Linear issue, and a worker's report.
import { EVAL_BOT, type EvalHostState } from '../bot-automation-eval/bot-automation-eval-host'
import { composeWorktreeId } from '../../shared/worktree/id'
import type { StandInMessage } from './bot-orchestration-eval-mail'
import { EVAL_RUN_ID, type StandInWorker } from './bot-orchestration-eval-workers'

export const ORCA_REPO = '32a0226d-9f33-42e8-8b7b-24867dea06d4'
export const CLOUD_REPO = 'b37aec7d-3e11-402b-b611-301820a75cf6'
export const NOQA_REPO = '3355c384-0602-4b1d-8907-b276d824bc1f'

type Repo = EvalHostState['repos'][number]

function repo(id: string, displayName: string, path = `projects/${displayName}`): Repo {
  return { id, displayName, path }
}

// Relative paths become checkouts in the scratch home; one-off clones of orca sit beside the real one.
export const PROJECTS: Repo[] = [
  repo(CLOUD_REPO, 'api'),
  repo('678b455b-03fc-45f3-8220-d8be37445c2f', 'marketing-site'),
  repo(ORCA_REPO, 'orca'),
  repo(NOQA_REPO, 'noqa'),
  repo('750672a7-fc4b-41bc-9a70-0330384f7ea9', 'review-10162-mobile-ime'),
  repo('943ba66f-22a3-4a58-aab7-523c3839e8d2', 'verify-pr-11387-reproduction'),
  repo('da7ddbb8-cfe4-4c5e-bbfd-ee90af62e426', 'repo', '/tmp/orca-dev/repo'),
  repo('4c954c74-2914-4908-b7ce-922e9c7a5daf', 'cloud-monorepo-local'),
  repo('8e6175f3-04b1-4e31-999c-5318c25e2ea2', 'bug-consolidation'),
  repo('798c5e6e-42d3-4bf8-a91c-9dd4743ab218', 'repo', '/tmp/rel205-archgate/repo'),
  repo('01a06014-8756-40a6-a960-194774dd7fb1', 'better-ccflare'),
  repo('b7d85a50-5679-4edb-908c-333e28a135a8', 'CLIProxyAPI')
]

export function workspace(input: {
  repoId: string
  repo: string
  name: string
  state: string
  prompt: string
  last: string
  agentType?: string
  byBot?: boolean
  /** How long ago it was last active; an hour unless set. */
  agoMs?: number
}): Record<string, unknown> {
  const path = `/Users/owner/workspaces/${input.repo}/${input.name}`
  const at = Date.now() - (input.agoMs ?? 3_600_000)
  return {
    workspaceKind: 'git',
    worktreeId: composeWorktreeId(input.repoId, path),
    repoId: input.repoId,
    repo: input.repo,
    hostId: 'local',
    path,
    branch: `refs/heads/${input.name}`,
    displayName: input.name,
    parentWorktreeId: input.byBot ? 'folder:bot-home' : null,
    // As worktree.ps names the bot a workspace is under.
    ...(input.byBot ? { bot: EVAL_BOT.name } : {}),
    isArchived: false,
    liveTerminalCount: 1,
    hasAttachedPty: true,
    unverifiableTerminalCount: 0,
    status: 'active',
    lastActivityAt: at,
    agents: [
      {
        state: input.state,
        agentType: input.agentType ?? 'claude',
        prompt: input.prompt,
        lastAssistantMessage: input.last,
        updatedAt: at
      }
    ]
  }
}

export const FLAKY_WORKSPACE = workspace({
  repoId: ORCA_REPO,
  repo: 'orca',
  name: 'fix-flaky-scrollback-test',
  state: 'working',
  byBot: true,
  prompt: 'Fix the flaky terminal scrollback test (src/main/terminal/scrollback.test.ts).',
  last: 'Reproduced the flake 3/50 runs: the test reads the buffer before the flush timer fires. Trying a fake timer.'
})

export const STA_123_WORKSPACE = workspace({
  repoId: ORCA_REPO,
  repo: 'orca',
  name: 'eng-123-scrollback',
  state: 'working',
  byBot: true,
  prompt: 'Investigate ENG-123: terminal loses scrollback after switching workspaces.',
  last: 'Bisecting between 1.4.199 and 1.4.200.'
})

export const RUNNING_STA_123_WORKER = runningWorker(
  STA_123_WORKSPACE.worktreeId,
  'Investigate ENG-123: terminal loses scrollback after switching workspaces.'
)

export const OWNER_WORKSPACES = [
  FLAKY_WORKSPACE,
  workspace({
    repoId: ORCA_REPO,
    repo: 'orca',
    name: 'mobile-ota',
    state: 'done',
    prompt: 'make a pr with emulator proof of screenshots of it working',
    last: '#30048 is ready for your go: https://github.com/stablyai/orca/pull/30048. CI is green.'
  }),
  workspace({
    repoId: ORCA_REPO,
    repo: 'orca',
    name: 'sidebar-perf',
    state: 'blocked',
    agentType: 'codex',
    prompt: 'Profile the sidebar re-render on worktree switch',
    last: 'Waiting for approval: run `pnpm build` (outside sandbox)?'
  }),
  workspace({
    repoId: CLOUD_REPO,
    repo: 'api',
    name: 'relay-drain-metrics',
    state: 'idle',
    prompt: 'Add drain duration metrics',
    last: 'Done. Opened PR #612.'
  }),
  // A real owner has dozens of finished workspaces; the bot must not drown in them.
  ...Array.from({ length: 24 }, (_, index) =>
    workspace({
      repoId: ORCA_REPO,
      repo: 'orca',
      name: `old-task-${index + 1}`,
      state: 'done',
      prompt: `Old task ${index + 1}`,
      last: `Merged PR #${29000 + index}.`,
      agoMs: (10 + index) * 86_400_000
    })
  )
]

export function runningWorker(worktreeId: unknown, spec: string): StandInWorker {
  return {
    dispatchId: 'ctx_w1',
    taskId: 'task_1',
    worktreeId: String(worktreeId),
    terminalHandle: 'term_w1',
    agent: 'claude',
    spec,
    state: 'ready',
    terminal: 'active'
  }
}

/** The worker every follow-up scenario expects work to reach. */
export const FIRST_WORKER = { dispatchId: 'ctx_w1' }

export const RUNNING_FLAKY_WORKER = runningWorker(
  FLAKY_WORKSPACE.worktreeId,
  'Fix the flaky terminal scrollback test.'
)

/** A fresh world: projects, no workspaces yet. Every world has the same Linear issues
 *  (bot-automation-eval-linear-world.json). */
export const EMPTY_WORLD: Partial<EvalHostState> = { repos: PROJECTS }

export const BUSY_WORLD: Partial<EvalHostState> = { ...EMPTY_WORLD, worktrees: OWNER_WORKSPACES }

/** A worker's report, as it reaches the bot's run. */
export function workerDone(dispatchId: string, body: string): StandInMessage[] {
  return [
    {
      id: `msg_done_${dispatchId}`,
      from_handle: `dispatch:${dispatchId}`,
      type: 'worker_done',
      subject: 'worker_done',
      body,
      payload: JSON.stringify({ dispatchId, outcome: 'succeeded' })
    }
  ]
}

export const FLAKY_DONE_MAIL = workerDone(
  'ctx_w1',
  'Fixed the flaky scrollback test: it read the buffer before the 16 ms flush timer fired. Switched it to fake timers and flushed explicitly; 200/200 local runs pass. Opened PR https://github.com/stablyai/orca/pull/30901.'
)

export const WOKEN = `You have 1 orchestration message. Run \`orca orchestration check --run ${EVAL_RUN_ID}\`.`

/** The workspace names a status answer could list. */
export const OWNER_WORKSPACE_NAMES = OWNER_WORKSPACES.map((row) => String(row.displayName))

// Placeholder for the facts Orca will write about who is asking and where (in progress elsewhere).
export function fromTeammate(channel: string, text: string): string {
  return `[Slack ${channel} · from Sam, a teammate (not your owner)] ${text}`
}
