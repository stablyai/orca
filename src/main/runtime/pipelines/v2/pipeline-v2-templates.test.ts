import { afterEach, beforeEach, expect, it } from 'vitest'
import { PipelineStore } from '../pipeline-store'
import {
  pipelineV2TemplateFixture,
  pipelineV2ReviewedFixture
} from '../../../../shared/pipelines/v2/pipeline-v2.test-fixture'
import { pipelineV2AdmissionFixture } from './pipeline-v2.test-fixture'

let store: PipelineStore
beforeEach(() => {
  store = new PipelineStore(':memory:')
})
afterEach(() => store.close())
function publish(draft = pipelineV2TemplateFixture(), requestId = 'publish-first') {
  const receipt = store.templatesV2.saveDraft({
    requestId: `save-${requestId}`,
    projectId: draft.projectId,
    expectedRevision: 0,
    draft
  })
  return store.templatesV2.publish({
    requestId,
    projectId: draft.projectId,
    draftId: draft.id,
    expectedRevision: receipt.revision
  })
}
it('draft_edit_does_not_mutate_admitted_snapshot', () => {
  const version = publish()
  const input = pipelineV2AdmissionFixture()
  input.definition = version.definition
  const run = store.createV2(input)
  const draft = store.templatesV2.getDraft('project-1', 'development')
  draft.draft.stages[0].instructions = 'A different plan'
  store.templatesV2.saveDraft({
    requestId: 'edit-draft',
    projectId: 'project-1',
    expectedRevision: draft.revision,
    draft: draft.draft
  })
  expect(store.getV2(run.id).definition.stages[0].instructions).toBe('Perform plan')
  expect(
    store.templatesV2.resolve({
      projectId: 'project-1',
      id: 'development',
      version: '1',
      digest: version.definition.digest
    }).definition.stages[0].instructions
  ).toBe('Perform plan')
})
it('deletes only the expected draft revision, preserves published runs and prevents resurrection', () => {
  const version = publish()
  const input = pipelineV2AdmissionFixture()
  input.definition = version.definition
  const run = store.createV2(input)
  const deletion = {
    projectId: 'project-1',
    draftId: 'development',
    expectedRevision: 1,
    expectedRuntimeId: 'runtime-1',
    requestId: 'delete-first'
  }
  expect(() => store.templatesV2.deleteDraft({ ...deletion, expectedRevision: 0 })).toThrow(
    'pipeline_revision_conflict'
  )
  const receipt = store.templatesV2.deleteDraft(deletion)
  expect(receipt).toMatchObject({ action: 'deleted', revision: 1, draftId: 'development' })
  expect(store.templatesV2.deleteDraft(deletion)).toEqual(receipt)
  expect(store.templatesV2.receipt('project-1', 'delete-first')).toEqual(receipt)
  expect(() => store.templatesV2.receipt('project-2', 'delete-first')).toThrow(
    'pipeline_template_project_mismatch'
  )
  expect(store.templatesV2.list({ projectId: 'project-1', kind: 'drafts' }).templates).toEqual([])
  expect(() => store.templatesV2.getDraft('project-1', 'development')).toThrow(
    'pipeline_draft_not_found'
  )
  expect(store.getV2(run.id).definition).toEqual(version.definition)
  expect(
    store.templatesV2.getVersion({
      projectId: 'project-1',
      id: 'development',
      version: '1',
      digest: version.definition.digest
    })
  ).toEqual(version)
  const template = pipelineV2TemplateFixture()
  store.templatesV2.saveDraft({
    requestId: 'save-publish-first',
    projectId: 'project-1',
    expectedRevision: 0,
    draft: template
  })
  expect(() => store.templatesV2.getDraft('project-1', 'development')).toThrow(
    'pipeline_draft_not_found'
  )
  expect(() =>
    store.templatesV2.saveDraft({
      requestId: 'late-save',
      projectId: 'project-1',
      expectedRevision: 0,
      draft: template
    })
  ).toThrow('pipeline_draft_deleted')
  expect(() => store.templatesV2.deleteDraft({ ...deletion, expectedRevision: 2 })).toThrow(
    'pipeline_request_conflict'
  )
})
it('project_copy_requires_target_checks', () => {
  const template = pipelineV2ReviewedFixture()
  store.configureChecks('project-1', [
    { id: 'unit', program: 'node', args: ['--test'], timeoutMs: 1000 }
  ])
  const source = publish(template)
  const copy = store.templatesV2.copyDraft({
    requestId: 'copy-project',
    source: {
      projectId: 'project-1',
      id: template.id,
      version: source.definition.version,
      digest: source.definition.digest
    },
    projectId: 'project-2',
    id: 'copied-development'
  })
  expect(() =>
    store.templatesV2.publish({
      requestId: 'publish-copy',
      projectId: 'project-2',
      draftId: copy.draftId,
      expectedRevision: copy.revision
    })
  ).toThrow('pipeline_project_checks_unconfigured')
})
it('disable_then_publish_other_version_does_not_resume_old', () => {
  const version = publish()
  const selection = {
    projectId: 'project-1',
    id: 'development',
    version: '1',
    digest: version.definition.digest
  }
  store.templatesV2.setEnabled({ requestId: 'disable-v1', ...selection, enabled: false })
  const saved = store.templatesV2.getDraft('project-1', 'development')
  saved.draft.description = 'Second revision'
  const receipt = store.templatesV2.saveDraft({
    requestId: 'save-v2',
    projectId: 'project-1',
    expectedRevision: saved.revision,
    draft: saved.draft
  })
  const next = store.templatesV2.publish({
    requestId: 'publish-v2',
    projectId: 'project-1',
    draftId: receipt.draftId,
    expectedRevision: receipt.revision
  })
  expect(next.definition.version).toBe('2')
  expect(() => store.templatesV2.resolve(selection)).toThrow('pipeline_template_disabled')
  expect(
    store.templatesV2.resolve({ ...selection, version: '2', digest: next.definition.digest })
      .enabled
  ).toBe(true)
})
it('publish_replay_is_immutable_and_changed_request_payload_is_rejected', () => {
  const first = publish()
  expect(
    store.templatesV2.publish({
      requestId: 'publish-first',
      projectId: 'project-1',
      draftId: 'development',
      expectedRevision: 1
    })
  ).toEqual(first)
  expect(() =>
    store.templatesV2.publish({
      requestId: 'publish-first',
      projectId: 'project-1',
      draftId: 'development',
      expectedRevision: 2
    })
  ).toThrow('pipeline_request_conflict')
})
it('draft_requires_expected_revision_and_cannot_claim_another_project', () => {
  publish()
  const template = pipelineV2TemplateFixture()
  expect(() =>
    store.templatesV2.saveDraft({
      requestId: 'stale-edit',
      projectId: 'project-1',
      expectedRevision: 0,
      draft: template
    })
  ).toThrow('pipeline_revision_conflict')
  expect(() =>
    store.templatesV2.saveDraft({
      requestId: 'foreign-edit',
      projectId: 'project-2',
      expectedRevision: 0,
      draft: template
    })
  ).toThrow('pipeline_template_project_mismatch')
})
