import { afterEach, beforeEach, expect, it } from 'vitest'
import { PipelineStore } from '../pipeline-store'
import {
  createPipelineTemplateOwnerActions,
  type PipelineTemplateOwnerActions
} from './pipeline-v2-template-owner-actions'
import {
  gatedV2Template,
  pipelineV2AdmissionFixture,
  settleV2Stage
} from './pipeline-v2.test-fixture'
import type { PipelineV2TemplateSelection } from '../../../../shared/pipelines/v2/pipeline-v2-template-contracts'

let store: PipelineStore
let owner: PipelineTemplateOwnerActions
let selection: PipelineV2TemplateSelection
beforeEach(() => {
  store = new PipelineStore(':memory:')
  const template = gatedV2Template()
  store.templatesV2.saveDraft({
    projectId: template.projectId,
    requestId: 'save',
    expectedRevision: 0,
    draft: template
  })
  const published = store.templatesV2.publish({
    projectId: template.projectId,
    requestId: 'publish',
    draftId: template.id,
    expectedRevision: 1
  })
  selection = {
    engineVersion: 2,
    projectId: template.projectId,
    id: template.id,
    version: published.definition.version,
    digest: published.definition.digest
  }
  store.createV2({ ...pipelineV2AdmissionFixture(template), definition: published.definition })
  settleV2Stage(store)
  owner = createPipelineTemplateOwnerActions({
    store,
    assertProject: async () => {},
    wake: () => {}
  })
})
afterEach(() => store.close())
it('repairs a disable whose library receipt committed before run propagation', async () => {
  const input = { ...selection, requestId: 'disable-before-crash', enabled: false }
  store.templatesV2.setEnabled(input)
  expect(store.getV2('run-1').definitionEnabled).toBe(true)
  await owner.disableTemplate(input)
  expect(store.getV2('run-1')).toMatchObject({
    state: 'paused',
    definitionEnabled: false,
    waitReason: 'owner_gate'
  })
  const revision = store.getV2('run-1').revision
  await owner.disableTemplate(input)
  expect(store.getV2('run-1').revision).toBe(revision)
})
it('does not let an old replay reverse newer availability and repairs an ABA crash with a fresh propagation receipt', async () => {
  const first = { ...selection, requestId: 'disable-first', enabled: false }
  await owner.disableTemplate(first)
  await owner.disableTemplate({ ...selection, requestId: 'enable-newer', enabled: true })
  await owner.disableTemplate(first)
  expect(store.getV2('run-1').definitionEnabled).toBe(true)
  expect(store.templatesV2.getVersion(selection).enabled).toBe(true)
  store.templatesV2.setEnabled({ ...selection, requestId: 'disable-newer-crash', enabled: false })
  await owner.disableTemplate(first)
  expect(store.getV2('run-1')).toMatchObject({ definitionEnabled: false, state: 'paused' })
})
