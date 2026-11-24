import { afterEach, beforeEach, expect, it } from 'vitest'
import { PipelineStore } from '../pipeline-store'
import { pipelineV2TemplateFixture } from '../../../../shared/pipelines/v2/pipeline-v2.test-fixture'
import type { PipelineV2LaunchEnvironment } from './pipeline-v2-launch'
import { admitPipelineV2 } from './pipeline-v2-admission'
import { pipelineV2AdmissionFixture } from './pipeline-v2.test-fixture'

let store: PipelineStore
beforeEach(() => {
  store = new PipelineStore(':memory:')
})
afterEach(() => store.close())
function host() {
  const launch: PipelineV2LaunchEnvironment = {
    settings: {
      agentLaunchChoices: { codex: { model: 'fixture-model-a', options: { effort: 'high' } } },
      agentPermissionDefault: 'own'
    },
    chatSupport: async () => ({ supported: true }),
    catalog: async () => ({
      origin: 'probe',
      fetchedAt: 1,
      listingNamesConfiguredModel: true,
      models: [
        {
          id: 'fixture-model-a',
          label: 'Fixture A',
          isDefault: true,
          defaultEffort: 'high',
          efforts: [{ value: 'high', label: 'High' }]
        },
        {
          id: 'fixture-model-b',
          label: 'Fixture B',
          isDefault: false,
          defaultEffort: 'low',
          efforts: [{ value: 'low', label: 'Low' }]
        }
      ]
    })
  }
  return {
    store,
    launch,
    project: { id: 'project-1', path: '/project', kind: 'git' as const, hostId: 'local' }
  }
}
function publish(template = pipelineV2TemplateFixture()) {
  const revision = store.templatesV2.saveDraft({
    requestId: 'save-first',
    projectId: 'project-1',
    expectedRevision: 0,
    draft: template
  }).revision
  return selection(
    store.templatesV2.publish({
      requestId: 'publish-first',
      projectId: 'project-1',
      draftId: template.id,
      expectedRevision: revision
    }).definition
  )
}
function selection(definition: { id: string; projectId: string; version: string; digest: string }) {
  return {
    engineVersion: 2 as const,
    id: definition.id,
    projectId: definition.projectId,
    version: definition.version,
    digest: definition.digest
  }
}
it('rejects admission before workspace effects when active runs fill capacity', async () => {
  const picked = publish()
  const admission = pipelineV2AdmissionFixture()
  for (let index = 0; index < 50; index++) {
    store.createV2({
      ...admission,
      id: `run-${index}`,
      requestId: `create-${index}`,
      workspace: { ...admission.workspace, instanceId: `instance-${index}` }
    })
  }
  await expect(admitPipelineV2(host(), picked, 'Inspect task', 'overflow')).rejects.toThrow(
    'pipeline_active_run_limit'
  )
  expect(() => store.creationSnapshotV2('overflow')).toThrow('pipeline_creation_snapshot_missing')
})
it('reserves capacity for admitted creations and preserves exact replays at capacity', async () => {
  const picked = publish()
  for (let index = 0; index < 50; index++) {
    await admitPipelineV2(host(), picked, 'Inspect task', `reservation-${index}`)
  }
  await expect(admitPipelineV2(host(), picked, 'Inspect task', 'reservation-50')).rejects.toThrow(
    'pipeline_active_run_limit'
  )
  expect(await admitPipelineV2(host(), picked, 'Inspect task', 'reservation-0')).toMatchObject({
    fresh: false,
    creationId: 'reservation-0',
    task: 'Inspect task'
  })
})
it('changed_defaults_do_not_change_reserved_resume_model', async () => {
  const template = pipelineV2TemplateFixture()
  for (const stage of template.stages) {
    if (stage.kind === 'agent') {
      stage.executor.model = { kind: 'default' }
      delete stage.executor.effort
    }
  }
  const picked = publish(template)
  const runtime = host()
  const first = await admitPipelineV2(runtime, picked, 'Implement the discount', 'creation-1')
  runtime.launch.settings.agentLaunchChoices = {
    codex: { model: 'fixture-model-b', options: { effort: 'low' } }
  }
  const replay = await admitPipelineV2(runtime, picked, 'Implement the discount', 'creation-1')
  expect(first.effectiveExecutors.implement.model).toBe('fixture-model-a')
  expect(replay.effectiveExecutors.implement).toEqual(first.effectiveExecutors.implement)
})
it('unavailable_model_leaves_no_creation_claim', async () => {
  const template = pipelineV2TemplateFixture()
  const stage = template.stages[0]
  if (stage.kind === 'agent') {
    stage.executor.model = { kind: 'explicit', id: 'unavailable-model' }
  }
  const picked = publish(template)
  await expect(
    admitPipelineV2(host(), picked, 'Implement the discount', 'creation-bad')
  ).rejects.toThrow('pipeline_model_unavailable')
  expect(() => store.creationSnapshotV2('creation-bad')).toThrow(
    'pipeline_creation_snapshot_missing'
  )
})
it('oversized_unicode_task_survives_create_error_and_can_be_retried_without_trimming', async () => {
  const template = pipelineV2TemplateFixture()
  template.stages[0].instructions = 'i'.repeat(5990)
  template.stages[0].expectedResult = 'result'
  const picked = publish(template)
  const task = '🔧'.repeat(4800)
  await expect(admitPipelineV2(host(), picked, task, 'unicode-creation')).rejects.toThrow(
    'pipeline_context_budget'
  )
  const draft = store.templatesV2.getDraft('project-1', template.id)
  draft.draft.stages[0].instructions = 'Read the task and make a plan'
  const saved = store.templatesV2.saveDraft({
    requestId: 'save-shorter-instructions',
    projectId: 'project-1',
    expectedRevision: draft.revision,
    draft: draft.draft
  })
  const version = store.templatesV2.publish({
    requestId: 'publish-shorter-instructions',
    projectId: 'project-1',
    draftId: saved.draftId,
    expectedRevision: saved.revision
  })
  const admitted = await admitPipelineV2(
    host(),
    selection(version.definition),
    task,
    'unicode-creation'
  )
  expect(admitted.task).toBe(task)
  expect(admitted.task.length).toBe(9600)
})
it('foreign_project_and_folder_targets_are_rejected_before_reservation', async () => {
  const picked = publish()
  await expect(
    admitPipelineV2(
      { ...host(), project: { id: 'other-project', path: '/other', kind: 'git', hostId: 'local' } },
      picked,
      'Inspect task',
      'foreign'
    )
  ).rejects.toThrow('pipeline_template_project_mismatch')
  await expect(
    admitPipelineV2(
      {
        ...host(),
        project: { id: 'project-1', path: '/project', kind: 'folder', hostId: 'local' }
      },
      picked,
      'Inspect task',
      'folder'
    )
  ).rejects.toThrow('pipeline_local_git_only')
})
