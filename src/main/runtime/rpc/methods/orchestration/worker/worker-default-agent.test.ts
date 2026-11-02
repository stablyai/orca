import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { RpcContext } from '../../../core'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/constants'
import type { Repo } from '../../../../../../shared/repo-types'
import { mockWorkerStartReady } from './worker-start-ready.test-fixture'

const resolveProjectDefaultAgent = vi.hoisted(() => vi.fn())
vi.mock('../../../../project-default-agent-resolution', () => ({ resolveProjectDefaultAgent }))

describe('orchestration project default agents', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext

  function setup(): void {
    ;({ db, runtime, ctx } = h.setup())
  }

  afterEach(() => {
    h.cleanup()
    resolveProjectDefaultAgent.mockReset()
  })

  function mockCurrentWorkerStart(options?: { ready?: boolean }): void {
    mockWorkerStartReady(runtime, h.coordinatorPaneKey, options)
  }

  async function call(name: string, params: Record<string, unknown>) {
    return h.call(name, params, ctx)
  }

  it('resolves the selected folder workspace default, not the floating coordinator', async () => {
    setup()
    mockCurrentWorkerStart()
    vi.mocked(runtime.showTerminal).mockResolvedValue({
      handle: 'term_coord',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      status: 'running'
    } as never)
    const workspace = await runtime.showManagedTerminalWorkspace('folder:workspace-b')
    vi.mocked(runtime.showManagedTerminalWorkspace).mockResolvedValue({
      ...workspace,
      id: 'folder:workspace-b',
      repoId: 'folder-workspace:group-b'
    })
    resolveProjectDefaultAgent.mockResolvedValue({
      agent: 'claude',
      source: 'project',
      projectId: 'project-b',
      projectName: 'Project B'
    })
    const task = db.createTask({ spec: 'folder workspace worker' })

    await expect(
      call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        worktree: 'folder:workspace-b',
        agent: 'default'
      })
    ).resolves.toMatchObject({
      state: 'ready',
      agentSelection: { agent: 'claude', source: 'project', projectId: 'project-b' }
    })
    expect(resolveProjectDefaultAgent).toHaveBeenCalledWith(runtime, {
      worktreeId: 'folder:workspace-b'
    })
    expect(runtime.createTerminal).toHaveBeenCalledWith(
      'id:folder:workspace-b',
      expect.objectContaining({ startupAgent: 'claude' })
    )
  })

  it('uses the target repository default for a cross-project new worker', async () => {
    setup()
    mockCurrentWorkerStart()
    const repo = {
      id: 'repo-b',
      path: '/repo-b',
      displayName: 'Project B',
      badgeColor: 'blue',
      addedAt: 1,
      kind: 'git'
    } satisfies Repo
    vi.spyOn(runtime, 'showRepo').mockResolvedValue(repo)
    vi.spyOn(runtime, 'createManagedWorktree').mockResolvedValue({
      worktree: {
        id: 'repo-b::new',
        repoId: 'repo-b',
        path: '/repo-b/new',
        head: 'abc',
        branch: 'new',
        isBare: false,
        isMainWorktree: false,
        displayName: 'New',
        comment: '',
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0
      },
      startupTerminal: { spawned: true, handle: 'term_worker' }
    })
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [],
      totalCount: 0,
      truncated: false
    })
    resolveProjectDefaultAgent.mockResolvedValue({
      agent: 'claude',
      source: 'project',
      projectId: 'project-b',
      projectName: 'Project B'
    })
    const task = db.createTask({ spec: 'cross-project work' })

    await expect(
      call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        worktree: 'new-top-level',
        repo: 'id:repo-b',
        name: 'worker-b',
        agent: 'default'
      })
    ).resolves.toMatchObject({
      state: 'ready',
      agentSelection: { agent: 'claude', source: 'project', projectId: 'project-b' }
    })
    expect(resolveProjectDefaultAgent).toHaveBeenCalledWith(runtime, {
      repo: expect.objectContaining({ id: 'repo-b' })
    })
    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ repoSelector: 'id:repo-b', startupAgent: 'claude' })
    )
  })

  it('rejects a target Blank Terminal before Dispatch and worktree creation', async () => {
    setup()
    mockCurrentWorkerStart()
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({
      id: 'repo-b',
      path: '/repo-b',
      displayName: 'Project B',
      badgeColor: 'blue',
      addedAt: 1,
      kind: 'git'
    })
    const create = vi.spyOn(runtime, 'createManagedWorktree')
    resolveProjectDefaultAgent.mockResolvedValue({
      agent: null,
      source: 'project',
      projectId: 'project-b',
      projectName: 'Project B'
    })
    const task = db.createTask({ spec: 'cross-project work' })

    await expect(
      call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        worktree: 'new-top-level',
        repo: 'id:repo-b',
        name: 'worker-b',
        agent: 'default'
      })
    ).rejects.toMatchObject({
      code: 'agent_unconfigured',
      message: expect.stringContaining('Project B')
    })
    expect(create).not.toHaveBeenCalled()
    expect(db.getDispatchContext(task.id)).toBeUndefined()
  })

  it('keeps the first resolved agent when a default worker is retried after settings change', async () => {
    setup()
    mockCurrentWorkerStart({ ready: false })
    resolveProjectDefaultAgent.mockResolvedValueOnce({ agent: 'codex', source: 'project' })
    resolveProjectDefaultAgent.mockResolvedValue({ agent: 'claude', source: 'project' })
    const task = db.createTask({ spec: 'retry the same agent' })

    const first = z.object({ dispatchId: z.string(), state: z.string() }).parse(
      await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'default'
      })
    )
    expect(first.state).toBe('failed')

    const retry = await call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      retryOf: first.dispatchId,
      agent: 'default'
    })

    expect(retry).toMatchObject({ agentSelection: { agent: 'codex', source: 'project' } })
    expect(resolveProjectDefaultAgent).toHaveBeenCalledTimes(1)
    expect(runtime.createTerminal).toHaveBeenLastCalledWith(
      'id:repo::worktree',
      expect.objectContaining({ startupAgent: 'codex' })
    )
  })

  it('lets a named agent explicitly override the first attempt on retry', async () => {
    setup()
    mockCurrentWorkerStart({ ready: false })
    resolveProjectDefaultAgent.mockResolvedValue({ agent: 'codex', source: 'project' })
    const task = db.createTask({ spec: 'override agent on retry' })
    const first = z.object({ dispatchId: z.string(), state: z.string() }).parse(
      await call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'default'
      })
    )
    expect(first.state).toBe('failed')

    await expect(
      call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        retryOf: first.dispatchId,
        agent: 'claude'
      })
    ).resolves.toMatchObject({ agentSelection: { agent: 'claude', source: 'explicit' } })
    expect(runtime.createTerminal).toHaveBeenLastCalledWith(
      'id:repo::worktree',
      expect.objectContaining({ startupAgent: 'claude' })
    )
  })
})
