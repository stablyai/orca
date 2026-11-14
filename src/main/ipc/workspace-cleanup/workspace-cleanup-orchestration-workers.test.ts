// Real Git and a real orchestration database: squash proofs and release rows are what mocks cannot model.
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installRealWorkerThreadChildProcesses } from '../../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { removeTree } from '../../../shared/windows-transient-lock-removal'
import type { Repo } from '../../../shared/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { WorktreeLineage } from '../../../shared/worktree/lineage-types'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import { OrchestrationDb } from '../../runtime/orchestration/db/orchestration-db'
import '../../runtime/orchestration/db/contract-constants'
import '../../runtime/orchestration/db/messages/mailbox-routing-page'
import '../../runtime/orchestration/db/dispatch-row-writer'
import '../../runtime/orchestration/db/attempt-outcome-projection'
import { scanWorkspaceCleanup } from './workspace-cleanup-scan'

const execFileAsync = promisify(execFile)
// Before any worker the tests start, whose terminals SQLite stamps with the real time.
const WORKSPACE_CREATED_AT = Date.parse('2026-01-01T00:00:00Z')

installRealWorkerThreadChildProcesses()

let scratchDir = ''
let repoPath = ''
let db: OrchestrationDb
const meta: Record<string, WorktreeMeta> = {}
const lineage: Record<string, WorktreeLineage> = {}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout.trim()
}

async function commitFile(cwd: string, name: string): Promise<void> {
  await writeFile(join(cwd, name), `${name}\n`)
  await git(['add', name], cwd)
  await git(['commit', '-qm', name], cwd)
}

async function addWorktree(name: string, from: string): Promise<{ id: string; path: string }> {
  const path = join(scratchDir, name)
  await git(['worktree', 'add', '-q', '-b', name, path, from], repoPath)
  const id = `repo::${path}`
  meta[id] = {
    instanceId: `${name}-instance`,
    displayName: name,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: WORKSPACE_CREATED_AT,
    createdAt: WORKSPACE_CREATED_AT
  }
  return { id, path }
}

async function addChild(
  name: string,
  coordinatorId: string
): Promise<{ id: string; path: string }> {
  const child = await addWorktree(name, 'coordinator')
  lineage[child.id] = {
    worktreeId: child.id,
    worktreeInstanceId: `${name}-instance`,
    parentWorktreeId: coordinatorId,
    parentWorktreeInstanceId: 'coordinator-instance',
    origin: 'cli',
    capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
    createdAt: WORKSPACE_CREATED_AT
  }
  return child
}

/** Starts a worker on the workspace and settles its report; follow-ups reuse the same terminal. */
function startWorker(
  worktreeId: string,
  handle: string,
  options: {
    action?: 'created_child' | 'reused'
    terminalOwnership?: 'created' | 'external'
    hostScope?: string
  } = {}
): string {
  const task = db.createTask({ runId: 'run_legacy_local', spec: handle })
  const dispatchId = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 9,
    taskId: task.id,
    startOptions: {}
  }).dispatch.id
  db.prepareStartingWorkerAuthority({
    dispatchId,
    handle,
    paneKey: `tab_${handle}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    processIncarnation: `pty:${handle}:1`,
    worktreeId,
    effects: [{ kind: 'worktree', action: options.action ?? 'created_child', id: worktreeId }],
    setupState: 'not_applicable',
    terminalOwnership: options.terminalOwnership ?? 'created',
    ...(options.hostScope ? { hostScope: options.hostScope } : {})
  })
  db.markWorkerDispatchReady(dispatchId)
  db.settleWorkerReport({ taskId: task.id, dispatchId, outcome: 'succeeded', result: 'done' })
  return dispatchId
}

function releaseWorker(dispatchId: string): void {
  const requested = db.requestWorkerTerminalRelease(dispatchId)
  if (requested.disposition !== 'requested') {
    throw new Error(`release was ${requested.disposition}`)
  }
  db.settleWorkerTerminalRelease(requested.resource.id)
}

async function scan(worktreeIds: string[]) {
  const repo: Repo = {
    id: 'repo',
    path: repoPath,
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scan reads only these store fields for a local repo.
  const store = {
    getRepos: () => [repo],
    getWorktreeMeta: (id: string) => meta[id],
    getAllWorktreeMeta: () => meta,
    getWorktreeLineage: (id: string) => lineage[id],
    getGitHubCache: () => ({ pr: {}, issue: {} })
  } as unknown as RuntimeStore
  const result = await scanWorkspaceCleanup(
    store,
    { worktreeIds },
    { getOrchestrationDb: () => db }
  )
  return new Map(
    result.candidates.map((candidate) => [
      candidate.worktreeId,
      { reasons: candidate.reasons, blockers: candidate.blockers }
    ])
  )
}

beforeEach(async () => {
  // Only Date: real timers keep Git subprocess timeouts working. A day after creation keeps rows active.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(WORKSPACE_CREATED_AT + 24 * 60 * 60 * 1000)
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-cleanup-workers-')))
  repoPath = join(scratchDir, 'repo')
  await git(['init', '-q', '-b', 'main', repoPath], scratchDir)
  await git(['config', 'user.email', 'cleanup@example.invalid'], repoPath)
  await git(['config', 'user.name', 'Cleanup'], repoPath)
  await git(['config', 'maintenance.auto', 'false'], repoPath)
  await git(['config', 'gc.auto', '0'], repoPath)
  await commitFile(repoPath, 'seed.txt')
  db = new OrchestrationDb(':memory:')
})

afterEach(async () => {
  vi.useRealTimers()
  db.close()
  for (const key of Object.keys(meta)) {
    delete meta[key]
  }
  for (const key of Object.keys(lineage)) {
    delete lineage[key]
  }
  await removeTree(scratchDir)
})

describe('workspace cleanup for released orchestration workers', () => {
  it('suggests a released worker whose work its coordinator squash-merged, and keeps the rest', async () => {
    const coordinator = await addWorktree('coordinator', 'main')
    const landed = await addChild('landed', coordinator.id)
    const unreleased = await addChild('unreleased', coordinator.id)
    const unlanded = await addChild('unlanded', coordinator.id)
    await commitFile(landed.path, 'landed.txt')
    await commitFile(unreleased.path, 'unreleased.txt')
    await commitFile(unlanded.path, 'unlanded.txt')
    // The coordinator squashes landed's and unreleased's work, never unlanded's.
    await git(['merge', '-q', '--squash', 'landed'], coordinator.path)
    await git(['commit', '-qm', 'squash landed'], coordinator.path)
    await git(['merge', '-q', '--squash', 'unreleased'], coordinator.path)
    await git(['commit', '-qm', 'squash unreleased'], coordinator.path)
    releaseWorker(startWorker(landed.id, 'term_landed'))
    startWorker(unreleased.id, 'term_unreleased')
    releaseWorker(startWorker(unlanded.id, 'term_unlanded'))

    const candidates = await scan([landed.id, unreleased.id, unlanded.id])

    expect(candidates.get(landed.id)).toEqual({ reasons: ['orchestration-worker'], blockers: [] })
    expect(candidates.get(unreleased.id)).toEqual({ reasons: [], blockers: ['unpushed-commits'] })
    expect(candidates.get(unlanded.id)).toEqual({ reasons: [], blockers: ['unpushed-commits'] })
  })

  it('suggests a worker workspace once the follow-up that took over its terminal is released', async () => {
    const coordinator = await addWorktree('coordinator', 'main')
    const child = await addChild('child', coordinator.id)
    startWorker(child.id, 'term_child')
    const followUp = startWorker(child.id, 'term_child', {
      action: 'reused',
      terminalOwnership: 'external'
    })
    expect((await scan([child.id])).get(child.id)?.reasons).toEqual(['unchanged'])

    releaseWorker(followUp)

    expect((await scan([child.id])).get(child.id)?.reasons).toEqual([
      'unchanged',
      'orchestration-worker'
    ])
  })
})
