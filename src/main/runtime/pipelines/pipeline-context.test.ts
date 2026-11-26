import { expect, it } from 'vitest'
import { PipelineStore } from './pipeline-store'

it('keeps serialized context within its published bound including active worker and source evidence', () => {
  const store = new PipelineStore(':memory:')
  try {
    let run = store.create({
      requestId: 'create',
      task: 't'.repeat(11998),
      workspace: {
        id: 'repo::task',
        instanceId: 'instance',
        projectId: 'repo',
        hostId: 'local',
        path: '/project'
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
    run = store.command(run.id, {
      requestId: 'plan',
      expectedRevision: run.revision,
      command: { kind: 'dispatch', dispatchId: 'd'.repeat(256), sessionId: 'm'.repeat(256) }
    })
    run = store.command(run.id, {
      requestId: 'submit',
      expectedRevision: run.revision,
      command: {
        kind: 'submit',
        dispatchId: run.active!.dispatchId,
        inputRevision: run.active!.inputRevision,
        sourceRevision: 'a'.repeat(64),
        body: 'b'.repeat(12000),
        verdict: 'pass'
      }
    })
    run = store.command(run.id, {
      requestId: 'implement',
      expectedRevision: run.revision,
      command: { kind: 'dispatch', dispatchId: 'i'.repeat(256), sessionId: 'm'.repeat(256) }
    })
    const context = {
      ...store.context(run.id, run.stage),
      active: run.active,
      sourceRevision: 'a'.repeat(64)
    }
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(16000)
    expect(context.artifacts[0].truncated).toBe(true)
  } finally {
    store.close()
  }
})
