import type { PipelineStore } from '../pipeline-store'
import { compilePipelineV2 } from '../../../../shared/pipelines/v2/pipeline-v2-compiler'
import { pipelineV2TemplateFixture } from '../../../../shared/pipelines/v2/pipeline-v2.test-fixture'
import type { PipelineV2Template } from '../../../../shared/pipelines/v2/pipeline-v2-contracts'

export const fixtureSource = 'a'.repeat(64)
export const fixtureSession = {
  kind: 'structured' as const,
  sessionId: 'primary-session',
  compatibilityKey: 'c'.repeat(64)
}

export function pipelineV2AdmissionFixture(template = pipelineV2TemplateFixture()) {
  return {
    id: 'run-1',
    requestId: 'create-run-1',
    workspace: {
      id: 'repo::/project/task',
      instanceId: 'instance-1',
      hostId: 'local' as const,
      projectId: 'project-1',
      path: '/project/task'
    },
    definition: compilePipelineV2(template),
    effectiveExecutors: Object.fromEntries(
      template.stages
        .filter((stage) => stage.kind === 'agent')
        .map((stage) => [
          stage.id,
          {
            agent: 'codex',
            model: 'fixture-model-a',
            effort: 'high',
            surface: 'chat',
            permissionMode: 'default',
            compatibilityKey: 'c'.repeat(64)
          }
        ])
    ),
    checkSnapshot: [],
    sourceRevision: fixtureSource,
    task: 'Implement cart discount without changing the API.',
    waitForSetup: false
  }
}

export function v2Mutation(store: PipelineStore, command: unknown, requestId?: string) {
  const run = store.getV2('run-1')
  return store.commandV2(run.id, {
    requestId: requestId ?? `request-${run.revision + 1}`,
    expectedRevision: run.revision,
    expectedInstanceId: run.workspace.instanceId,
    command
  })
}

export function settleV2Stage(store: PipelineStore, outcomeId = 'done') {
  const before = store.getV2('run-1')
  const invocationId = `invocation-${before.invocations.length + 1}`
  v2Mutation(store, {
    kind: 'reserve',
    invocationId,
    purpose: 'stage',
    sourceRevision: fixtureSource
  })
  const reserved = store.getV2('run-1').invocations.at(-1)!
  v2Mutation(store, {
    kind: 'bind',
    invocationId,
    dispatchId: invocationId,
    session: fixtureSession
  })
  v2Mutation(store, {
    kind: 'submit',
    invocationId,
    dispatchId: invocationId,
    inputRevision: reserved.inputRevision,
    sourceRevision: fixtureSource,
    result: {
      status: 'result',
      outcomeId,
      summary: `${before.stageId} result`,
      evidence: {
        stage: 'generic',
        statement: 'Expected result is available',
        rationale: 'The stage completed its work',
        files: []
      }
    }
  })
  return v2Mutation(store, { kind: 'settle', invocationId })
}

export function gatedV2Template(): PipelineV2Template {
  const template = pipelineV2TemplateFixture()
  template.stages[0].ownerGate.enabled = true
  return template
}
