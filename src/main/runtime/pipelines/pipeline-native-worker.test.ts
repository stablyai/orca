import { afterEach, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './testing/pipeline-worker-release.test-fixture'
import { getWorkerTerminalAutoReleaseScheduler } from '../orchestration/terminal-authority/release/worker-terminal-auto-release-scheduler'
import { pipelineWorkerPorts } from './pipeline-worker-adapter'
import { PipelineStore } from './pipeline-store'

const h = createOrchestrationWorkerReleaseHarness()
afterEach(() => {
  getWorkerTerminalAutoReleaseScheduler(h.runtime).clear()
  h.cleanup()
})

it('uses native system-owned Dispatch authority and reuses the primary session after settlement', async () => {
  h.setup()
  const store = new PipelineStore(':memory:')
  try {
    let run = store.create({
      requestId: 'create',
      task: 'Fix delivery',
      workspace: {
        id: 'repo::worktree',
        instanceId: 'instance',
        projectId: 'repo',
        hostId: 'local',
        path: '/project/task'
      },
      profile: {
        id: 'standard',
        version: '1',
        title: 'Development',
        checks: ['test'],
        maxFixCycles: 2,
        roles: { primary: { agent: 'codex' }, reviewer: { agent: 'codex' } }
      }
    })
    const ports = pipelineWorkerPorts(h.runtime)
    const prepared: string[] = []
    const original = vi.mocked(h.runtime.sendTerminalAgentPrompt).getMockImplementation()!
    vi.mocked(h.runtime.sendTerminalAgentPrompt).mockImplementation(async (...args) => {
      expect(store.get(run.id).active?.dispatchId).toBe(prepared.at(-1))
      return original(...args)
    })
    const first = await ports.start(run, 'Plan stage', (worker) => {
      prepared.push(worker.dispatchId)
      run = store.command(run.id, {
        requestId: 'bind',
        expectedRevision: run.revision,
        command: { kind: 'dispatch', ...worker }
      })
    })
    expect(first.state).toBe('ready')
    const dispatch = h.db.getDispatchContextById(first.dispatchId)!
    expect(h.db.getRun(dispatch.run_id)?.coordinator_handle).toBeNull()
    expect(run.primarySessionId).toBe('term_worker')
    h.settle(dispatch.task_id, dispatch.id, 'succeeded')
    expect(await ports.settled(dispatch.id)).toBe(true)
    run = store.command(run.id, {
      requestId: 'plan',
      expectedRevision: run.revision,
      command: {
        kind: 'submit',
        dispatchId: dispatch.id,
        inputRevision: run.active!.inputRevision,
        sourceRevision: 'a'.repeat(40),
        body: 'Plan evidence',
        verdict: 'pass'
      }
    })
    const second = await ports.start(run, 'Implement stage', (worker) => {
      prepared.push(worker.dispatchId)
      run = store.command(run.id, {
        requestId: 'bind-next',
        expectedRevision: run.revision,
        command: { kind: 'dispatch', ...worker }
      })
    })
    expect(second).toMatchObject({ state: 'ready', sessionId: 'term_worker' })
    expect(second.dispatchId).not.toBe(first.dispatchId)
    expect(h.db.getActiveDispatchForIdentity('term_worker', h.workerPaneKey)?.id).toBe(
      second.dispatchId
    )
  } finally {
    store.close()
  }
})
