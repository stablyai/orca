import type { WebContents } from 'electron'
type TestSender = Pick<WebContents, 'id' | 'isDestroyed' | 'getType' | 'getURL'>
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PipelineStore } from '../runtime/pipelines/pipeline-store'
import { pipelineV2TemplateFixture } from '../../shared/pipelines/v2/pipeline-v2.test-fixture'
import {
  gatedV2Template,
  pipelineV2AdmissionFixture,
  settleV2Stage
} from '../runtime/pipelines/v2/pipeline-v2.test-fixture'
import { createPipelineTemplateOwnerActions } from '../runtime/pipelines/v2/pipeline-v2-template-owner-actions'
import {
  registerPipelineTemplateHandlers,
  setTrustedPipelineRendererWebContentsId
} from './pipeline-owner-ipc'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: TestSender }, input: unknown) => Promise<unknown>>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: { sender: TestSender }, input: unknown) => Promise<unknown>
    ) => handlers.set(channel, handler)
  }
}))
let store: PipelineStore
beforeEach(() => {
  store = new PipelineStore(':memory:')
  setTrustedPipelineRendererWebContentsId(7)
  registerPipelineTemplateHandlers(() =>
    createPipelineTemplateOwnerActions({ store, assertProject: async () => {}, wake: () => {} })
  )
})
afterEach(() => store.close())
const sender = (id: number): TestSender => ({
  id,
  isDestroyed: () => false,
  getType: () => 'window',
  getURL: () => 'file:///orca/index.html'
})
const request = {
  requestId: 'publish-template',
  projectId: 'project-1',
  draftId: 'development',
  expectedRevision: 1
}
function save(gated = false) {
  store.templatesV2.saveDraft({
    requestId: 'save-draft',
    projectId: 'project-1',
    expectedRevision: 0,
    draft: gated ? gatedV2Template() : pipelineV2TemplateFixture()
  })
}
it('only_the_pinned_owner_renderer_can_publish_a_template', async () => {
  save()
  await expect(
    handlers.get('pipelineOwner:publishTemplate')!({ sender: sender(8) }, request)
  ).rejects.toThrow('pipeline_owner_required')
  expect(
    await handlers.get('pipelineOwner:publishTemplate')!({ sender: sender(7) }, request)
  ).toMatchObject({
    action: 'published',
    enabled: true,
    selection: { engineVersion: 2, id: 'development', version: '1', projectId: 'project-1' }
  })
})
it('disabling_a_version_keeps_the_candidate_but_pauses_its_run_and_replays_exactly', async () => {
  save(true)
  const receipt = await handlers.get('pipelineOwner:publishTemplate')!(
    { sender: sender(7) },
    request
  )
  store.createV2(pipelineV2AdmissionFixture(gatedV2Template()))
  settleV2Stage(store)
  const before = store.getV2('run-1').pendingDecision!
  const version = store.templatesV2.getDraft('project-1', 'development')
  const definition = store.templatesV2.publish(request).definition
  const input = {
    requestId: 'disable-template',
    engineVersion: 2,
    projectId: version.projectId,
    id: definition.id,
    version: definition.version,
    digest: definition.digest,
    enabled: false
  }
  const disabled = await handlers.get('pipelineOwner:disableTemplate')!(
    { sender: sender(7) },
    input
  )
  expect(disabled).toMatchObject({ action: 'disabled', enabled: false })
  expect(store.getV2('run-1')).toMatchObject({
    state: 'paused',
    definitionEnabled: false,
    pendingDecision: { candidateId: before.candidateId }
  })
  expect(
    await handlers.get('pipelineOwner:disableTemplate')!({ sender: sender(7) }, input)
  ).toEqual(disabled)
  expect(receipt).toMatchObject({ action: 'published', enabled: true })
})
