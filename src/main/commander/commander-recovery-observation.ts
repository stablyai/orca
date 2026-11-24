import type { AgentSessionConversationView } from '../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { AgentTurnOutcome } from '../../shared/agent-status/lifecycle/agent-turn-outcome'
import { HANDOFF_GOAL_LIMIT } from '../../shared/commander/goal-handoff'
import { isRepoOnCatalogHost } from '../../shared/execution-host/execution-host'
import { getProjectIdentityKey } from '../../shared/project/host-setup/project-host-setup-projection'
import type { Repo } from '../../shared/repository/repo-types'
import { parseWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { splitWorktreeId, worktreeIdsEqual } from '../../shared/worktree/id'
import type { Worktree } from '../../shared/worktree/types'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'

type RecoveryRepo = Pick<
  Repo,
  | 'id'
  | 'path'
  | 'kind'
  | 'upstream'
  | 'gitRemoteIdentity'
  | 'repoIcon'
  | 'connectionId'
  | 'executionHostId'
>
export type RecoveryRecord = Pick<
  AgentSessionConversationView,
  'sessionId' | 'provider' | 'lastTurn'
> & {
  location: Pick<
    AgentSessionConversationView['location'],
    'workspaceId' | 'executionHostId' | 'workspaceKind' | 'wslDistro'
  >
}
type RecoveryRuntime = {
  requireStore(): { getRepo(id: string): RecoveryRepo | undefined | null }
  showManagedWorktree(
    selector: string,
    host: 'local'
  ): Promise<Pick<Worktree, 'id' | 'repoId' | 'hostId' | 'path'>>
}

type RecoveryGit = { branch: string | null; head: string | null; dirty: boolean | null }
const unknownGit: RecoveryGit = { branch: null, head: null, dirty: null }

export type RecoveryObservation = RecoveryGit & {
  sessionId: string
  projectId: string
  provider: 'claude' | 'codex'
  at: number
  state: 'open' | 'settled'
  outcome?: AgentTurnOutcome
  goal: string
  progress: string
  nextStep: string
}

async function sampleGit(cwd: string): Promise<RecoveryGit> {
  const { stdout } = await gitExecFileAsync(
    [
      '--no-optional-locks',
      '-c',
      'core.fsmonitor=false',
      'status',
      '--porcelain=v2',
      '--branch',
      '--no-ahead-behind',
      '--untracked-files=normal',
      '--ignore-submodules=none',
      '-z'
    ],
    { cwd, admissionTier: 'background', signal: AbortSignal.timeout(5_000), maxBuffer: 128 * 1024 }
  )
  const rows = stdout.split('\0')
  let branch: string | null = null
  let head: string | null = null
  let dirty = false
  let sawHead = false
  for (const row of rows) {
    if (row.startsWith('# branch.oid ')) {
      const oid = row.slice('# branch.oid '.length)
      head = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid) ? oid : null
      sawHead = Boolean(head) || oid === '(initial)'
    } else if (row.startsWith('# branch.head ')) {
      const name = row.slice('# branch.head '.length)
      branch = name && name !== '(detached)' && name.length <= 1024 ? name : null
    } else if (row && !row.startsWith('# ')) {
      dirty = true
      break
    }
  }
  return sawHead ? { head, branch, dirty } : unknownGit
}

/** Read saved turn edges only. Resolve the checkout through the local catalog before touching Git. */
export async function readRecoveryObservation(
  runtime: RecoveryRuntime,
  record: RecoveryRecord
): Promise<RecoveryObservation | null> {
  const { provider, location, lastTurn: turn } = record
  if (
    (provider !== 'codex' && provider !== 'claude') ||
    !turn?.prompt?.trim() ||
    location.workspaceKind !== 'git-worktree' ||
    location.executionHostId !== 'local' ||
    location.wslDistro
  ) {
    return null
  }
  const scope = parseWorkspaceKey(location.workspaceId)
  const id = scope?.type === 'worktree' ? scope.worktreeId : location.workspaceId
  const identity = splitWorktreeId(id)
  if (scope?.type === 'folder' || !identity?.repoId || !identity.worktreePath) {
    return null
  }
  const store = runtime.requireStore()
  const repo = store.getRepo(identity.repoId)
  if (!repo || repo.kind === 'folder' || !isRepoOnCatalogHost(repo)) {
    return null
  }
  const projectId = getProjectIdentityKey(repo)
  let git = unknownGit
  try {
    const row = await runtime.showManagedWorktree(`id:${id}`, 'local')
    if (
      row.repoId !== repo.id ||
      !worktreeIdsEqual(id, row.id) ||
      (row.hostId && row.hostId !== 'local')
    ) {
      return null
    }
    git = await sampleGit(row.path)
  } catch {
    // The workspace may already be gone after a crash. Keep the durable turn, with unknown Git state.
  }
  const current = store.getRepo(repo.id)
  if (
    runtime.requireStore() !== store ||
    !current ||
    current.path !== repo.path ||
    !isRepoOnCatalogHost(current) ||
    current.kind === 'folder' ||
    getProjectIdentityKey(current) !== projectId
  ) {
    return null
  }
  const progress = turn.state === 'settled' ? turn.reply?.trim() : undefined
  return {
    ...git,
    sessionId: record.sessionId,
    provider,
    projectId,
    at: turn.at,
    state: turn.state,
    outcome: turn.outcome,
    goal: turn.prompt
      .trim()
      .slice(0, HANDOFF_GOAL_LIMIT)
      .replace(/[\uD800-\uDBFF]$/, ''),
    progress:
      progress?.replace(/[\uD800-\uDBFF]$/, '') ||
      (turn.state === 'open'
        ? 'The turn started. Orca did not record its completion.'
        : 'The turn ended without a saved reply preview.'),
    nextStep:
      turn.outcome === 'success' && turn.state === 'settled'
        ? 'Verify the reported result against the destination checkout before continuing.'
        : 'Inspect the destination checkout and verify the last completed step before retrying the goal.'
  }
}
