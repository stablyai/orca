import { afterEach, expect, it, vi } from 'vitest'
import { ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY } from '../../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { startRemoteOwnedWorker } from '../../../../../orchestration/federation/remote-owned/remote-owned-start'
import { createOrchestrationRpcHarness } from '../../rpc-test-harness'

const h = createOrchestrationRpcHarness()

const commander = {
  projectId: 'github:acme/wrong',
  decisionPageId: 'dispatch-11111111-1111-4111-8111-111111111111',
  reason: 'Documentation requires a short review.',
  guidelines: 'Run the documentation check.'
}

afterEach(() => {
  h.cleanup()
  vi.restoreAllMocks()
})

it('delivers owner guidance to an existing task only on its delegated project', async () => {
  const { db, runtime, ctx } = h.setup()
  vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
    handle === 'term_coord'
      ? h.coordinatorPaneKey
      : handle === 'term_worker'
        ? 'tab_worker:leaf_worker'
        : null
  )
  vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
  vi.spyOn(runtime, 'showTerminal')
  vi.mocked(runtime.showTerminal, { partial: true }).mockImplementation(async (handle) => ({
    handle,
    worktreeId: 'repo::worktree',
    status: 'running'
  }))
  vi.spyOn(runtime, 'showManagedWorktree')
  vi.mocked(runtime.showManagedWorktree, { partial: true }).mockResolvedValue({
    id: 'repo::worktree'
  })
  vi.spyOn(runtime, 'showManagedTerminalWorkspace')
  vi.mocked(runtime.showManagedTerminalWorkspace, { partial: true }).mockResolvedValue({
    id: 'repo::worktree',
    repoId: 'repo'
  })
  vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
    handle: 'term_worker',
    worktreeId: 'repo::worktree',
    title: 'worker'
  })
  vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
    handle: 'term_worker',
    condition: 'tui-idle',
    satisfied: true,
    status: 'running',
    exitCode: null
  })
  vi.mocked(runtime.getTerminalProcessIncarnation).mockImplementation((handle) =>
    handle === 'term_worker' ? 'runtime_test:term_worker:1' : null
  )
  vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
  vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
    handle: 'term_worker',
    accepted: true,
    bytesWritten: 1
  })
  vi.spyOn(runtime, 'showRepo')
  vi.mocked(runtime.showRepo, { partial: true }).mockResolvedValue({ id: 'repo' })
  vi.spyOn(runtime, 'listVisibleProjectHostSetups').mockReturnValue([
    {
      id: 'setup',
      repoId: 'repo',
      projectId: 'github:acme/sdk',
      hostId: 'local',
      path: '/repo',
      displayName: 'SDK',
      setupState: 'ready',
      setupMethod: 'cloned',
      createdAt: 0,
      updatedAt: 0
    }
  ])
  const task = db.createTask({ spec: 'Update README' })
  const request = { task: task.id, from: 'term_coord', agent: 'codex', commander }
  await expect(h.call('orchestration.workerStart', request, ctx)).rejects.toThrow(
    'different project'
  )
  expect(db.getDispatchContext(task.id)).toBeUndefined()
  await h.call(
    'orchestration.workerStart',
    {
      ...request,
      commander: { ...commander, projectId: 'github:acme/sdk' }
    },
    ctx
  )
  expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
    'term_worker',
    expect.stringContaining('Update README\n\nRun the documentation check.'),
    expect.anything()
  )
  expect(
    JSON.parse(db.getWorkerDispatch(db.getDispatchContext(task.id)!.id)!.start_options)
  ).toMatchObject({
    routingDecision: 'dispatch-11111111-1111-4111-8111-111111111111',
    routingReason: 'Documentation requires a short review.'
  })
  expect(db.getTask(task.id)?.spec).toBe('Update README')
})

it('refuses a paired host that owns workers but cannot validate Commander projects before binding a run', async () => {
  const { runtime, ctx, db } = h.setup(false)
  const initialRuns = db.listRuns()
  vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockResolvedValue({
    name: 'build-server',
    environmentId: 'server',
    peerFingerprint: 'pair-1'
  })
  const remoteCall = vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockResolvedValue({
    runtimeId: 'server-runtime',
    capabilities: [ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY]
  })
  await expect(
    startRemoteOwnedWorker(
      runtime,
      { from: 'term_coord', on: 'server', spec: 'Update README', agent: 'codex', commander },
      ctx,
      undefined
    )
  ).rejects.toMatchObject({ code: 'capability_unsupported' })
  expect(remoteCall.mock.calls.map(([, method]) => method)).toEqual(['status.get'])
  expect(db.listRuns()).toEqual(initialRuns)
})
