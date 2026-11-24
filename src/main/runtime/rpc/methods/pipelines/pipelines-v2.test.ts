import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcDispatcher } from '../../dispatcher'
import type { PipelineStore } from '../../../pipelines/pipeline-store'
import { settleV2Stage } from '../../../pipelines/v2/pipeline-v2.test-fixture'
import type { SessionCallerHarness } from '../../../pipelines/testing/pipeline-session-caller.test-fixture'
import {
  pipelineV2TemplateFixture,
  pipelineV2AgentStage
} from '../../../../../shared/pipelines/v2/pipeline-v2.test-fixture'
import { createPipelineV2RpcTestHarness } from './pipelines-v2.test-support'
import { createPipelineTemplateOwnerActions } from '../../../pipelines/v2/pipeline-v2-template-owner-actions'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock(
  '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({ getStructuredAgentSessionHost: () => hostRef.current })
)
let h: SessionCallerHarness
let store: PipelineStore
let dispatcher: RpcDispatcher
const scope = {
  id: 'run-1',
  projectId: 'project-1',
  expectedInstanceId: 'instance-1',
  expectedRuntimeId: 'runtime-v2'
}
beforeEach(() => {
  ;({ h, store, dispatcher } = createPipelineV2RpcTestHarness(hostRef))
})
afterEach(() => {
  store.close()
  h.close()
  vi.restoreAllMocks()
})
const call = (method: string, params: unknown) =>
  dispatcher.dispatch({ id: 'rpc-v2', authToken: 'test', method, params })
it('allows the owner to inspect an old-runtime proposal without changing its original pins', async () => {
  const waiting = settleV2Stage(store)
  await call('pipeline.v2.decision.request', {
    ...scope,
    requestId: 'before-restart',
    expectedRevision: waiting.revision,
    action: 'accept',
    pin: waiting.pendingDecision
  })
  vi.spyOn(h.runtime, 'getRuntimeId').mockReturnValue('new-runtime')
  expect(
    await call('pipeline.v2.decision.receipt', {
      projectId: 'project-1',
      requestId: 'before-restart',
      expectedRuntimeId: 'new-runtime'
    })
  ).toMatchObject({
    ok: true,
    result: {
      request: { input: { expectedRuntimeId: 'runtime-v2' } },
      receipt: null
    }
  })
  expect(store.getV2('run-1').pendingDecision).toEqual(waiting.pendingDecision)
})
it('decision_request_does_not_resolve_and_no_public_resolve_method_exists', async () => {
  const waiting = settleV2Stage(store)
  const response = await call('pipeline.v2.decision.request', {
    ...scope,
    requestId: 'owner-request-1',
    expectedRevision: waiting.revision,
    action: 'accept',
    pin: waiting.pendingDecision
  })
  expect(response).toMatchObject({
    ok: true,
    result: { request: { requestId: 'owner-request-1', kind: 'decision', state: 'pending' } }
  })
  expect(store.getV2('run-1')).toMatchObject({ state: 'waiting_owner', revision: waiting.revision })
  expect(
    await call('pipeline.v2.resolveDecision', { ...scope, client: { type: 'owner' } })
  ).toMatchObject({ ok: false, error: { code: 'method_not_found' } })
})
it('v2_controls_return_exact_receipts_and_reject_foreign_identity_before_effects', async () => {
  expect(
    await call('pipeline.v2.pause', {
      ...scope,
      projectId: 'foreign',
      requestId: 'wrong-project',
      expectedRevision: 0
    })
  ).toMatchObject({ ok: false })
  expect(
    await call('pipeline.v2.pause', {
      ...scope,
      expectedRuntimeId: 'foreign',
      requestId: 'wrong-runtime',
      expectedRevision: 0
    })
  ).toMatchObject({ ok: false })
  expect(
    await call('pipeline.v2.pause', { ...scope, requestId: 'pause-once', expectedRevision: 0 })
  ).toMatchObject({
    ok: true,
    result: {
      receipt: { requestId: 'pause-once', inputRevision: 0, acceptedRevision: 1, state: 'paused' }
    }
  })
  expect(
    await call('pipeline.v2.receipt', {
      ...scope,
      requestId: 'pause-once',
      expectedRevision: 0,
      kind: 'pause'
    })
  ).toMatchObject({ ok: true, result: { receipt: { acceptedRevision: 1, state: 'paused' } } })
  expect(store.getV2('run-1').revision).toBe(1)
  expect(await call('pipeline.status', { id: 'run-1' })).toMatchObject({ ok: false })
})
it('describes_version_two_without_claiming_generic_workflows_are_source_ready', async () => {
  store.configureChecks('project-1', [
    { id: 'unit', program: 'make', args: ['test'], timeoutMs: 10000 }
  ])
  expect(await call('pipeline.v2.describe', { projectId: 'project-1' })).toMatchObject({
    ok: true,
    result: { configuredChecks: [{ id: 'unit' }] }
  })
  expect(await call('pipeline.v2.describe', { projectId: 'foreign' })).toMatchObject({ ok: false })
  expect(await call('pipeline.v2.describe', {})).toMatchObject({
    ok: true,
    result: { version: 2, ownerResolution: 'native-ipc-only' }
  })
  expect(await call('pipeline.v2.status', scope)).toMatchObject({
    ok: true,
    result: { run: { id: 'run-1', engineVersion: 2 }, ready: false }
  })
  expect(await call('pipeline.v2.describe', { ...scope, stageId: 'plan' })).toMatchObject({
    ok: true,
    result: {
      submitExample: {
        expectedInstanceId: 'instance-1',
        command: { kind: 'submit', result: { evidence: { stage: 'generic' } } }
      }
    }
  })
})
it('previews the effective saved model instead of claiming the provider default is the launch choice', async () => {
  const template = pipelineV2TemplateFixture()
  template.stages = [pipelineV2AgentStage('plan')]
  template.stages[0].outcomes[0].target = { kind: 'finish' }
  const stage = template.stages[0]
  if (stage.kind !== 'agent') {
    throw new Error('Expected agent fixture')
  }
  stage.executor = {
    ...stage.executor,
    model: { kind: 'default' },
    surface: 'terminal',
    effort: undefined
  }
  store.templatesV2.saveDraft({
    projectId: 'project-1',
    requestId: 'preview-draft',
    expectedRevision: 0,
    draft: template
  })
  vi.mocked(h.runtime.requireStore).mockReturnValue(
    partialRuntimeStore({
      getRepo: (id: string) => storeRepo({ id, path: '/project', kind: 'git' }),
      getSettings: () => ({
        agentLaunchChoices: { codex: { model: 'owner-picked', options: { effort: 'high' } } }
      })
    })
  )
  const modelCatalog: Pick<
    NonNullable<Awaited<ReturnType<typeof h.runtime.structuredAgentModelCatalog>>>,
    'read'
  > = {
    read: async () => ({
      origin: 'probe',
      fetchedAt: 0,
      listingNamesConfiguredModel: true,
      models: [
        { id: 'provider-default', label: 'Provider default', isDefault: true, efforts: [] },
        {
          id: 'owner-picked',
          label: 'Owner choice',
          isDefault: false,
          efforts: [{ value: 'high', label: 'High' }]
        }
      ]
    })
  }
  vi.spyOn(h.runtime, 'structuredAgentModelCatalog').mockResolvedValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Launch preview only reads the fixture catalog; it never starts its cache or probe lifecycle.
    modelCatalog as Awaited<ReturnType<typeof h.runtime.structuredAgentModelCatalog>>
  )
  expect(
    await call('pipeline.v2.template.show', {
      projectId: 'project-1',
      draftId: template.id,
      full: true
    })
  ).toMatchObject({
    ok: true,
    result: {
      launchPreview: [
        {
          stageId: 'plan',
          state: 'available',
          executor: { model: 'owner-picked', effort: 'high', surface: 'terminal' }
        }
      ]
    }
  })
  modelCatalog.read = async () => ({
    origin: 'probe',
    fetchedAt: 0,
    listingNamesConfiguredModel: false,
    models: []
  })
  expect(
    await call('pipeline.v2.template.show', {
      projectId: 'project-1',
      draftId: template.id,
      full: true
    })
  ).toMatchObject({
    ok: true,
    result: {
      launchPreview: [
        { stageId: 'plan', state: 'unavailable', reason: 'pipeline_model_unavailable' }
      ]
    }
  })
})
it('draft_stage_operations_replay_without_duplicate_insertion_or_publication', async () => {
  const base = { projectId: 'project-1', expectedRuntimeId: 'runtime-v2' }
  expect(
    await call('pipeline.v2.template.save', {
      ...base,
      requestId: 'draft-first',
      expectedRevision: 0,
      draft: pipelineV2TemplateFixture()
    })
  ).toMatchObject({ ok: true, result: { receipt: { draftId: 'development', revision: 1 } } })
  const edit = {
    ...base,
    requestId: 'insert-custom-once',
    expectedRevision: 1,
    draftId: 'development',
    operations: [
      { kind: 'insert', afterStageId: 'plan', stage: pipelineV2AgentStage('custom-stage') }
    ]
  }
  expect(await call('pipeline.v2.template.save', edit)).toMatchObject({
    ok: true,
    result: { receipt: { revision: 2 } }
  })
  expect(await call('pipeline.v2.template.save', edit)).toMatchObject({
    ok: true,
    result: { receipt: { revision: 2 } }
  })
  expect(
    store.templatesV2.getDraft('project-1', 'development').draft.stages.map((stage) => stage.id)
  ).toEqual(['plan', 'custom-stage', 'implement', 'review'])
  expect(await call('pipeline.v2.profiles', base)).toMatchObject({
    ok: true,
    result: { profiles: [] }
  })
  expect(
    await call('pipeline.v2.template.validate', {
      ...base,
      draftId: 'development',
      expectedRevision: 2
    })
  ).toMatchObject({ ok: true, result: { valid: true } })
  const reorder = {
    ...base,
    requestId: 'reorder-custom',
    expectedRevision: 2,
    draftId: 'development',
    operations: [{ kind: 'reorder', stageIds: ['plan', 'implement', 'custom-stage', 'review'] }]
  }
  expect(await call('pipeline.v2.template.save', reorder)).toMatchObject({
    ok: true,
    result: { receipt: { revision: 3 } }
  })
  expect(
    store.templatesV2.getDraft('project-1', 'development').draft.stages.map((stage) => stage.id)
  ).toEqual(['plan', 'implement', 'custom-stage', 'review'])
})
it('public_discussion_preserves_transport_pins_without_treating_them_as_owner_acceptance', async () => {
  const waiting = settleV2Stage(store)
  const input = {
    ...scope,
    requestId: 'discuss-same-session',
    expectedRevision: waiting.revision,
    pin: waiting.pendingDecision,
    message: 'Объясни откат: $(touch data)'
  }
  expect(await call('pipeline.v2.discuss', input)).toMatchObject({
    ok: true,
    result: { receipt: { state: 'ready', session: { sessionId: 'primary-session' } } }
  })
  expect(store.getV2('run-1')).toMatchObject({ state: 'waiting_owner', stageId: 'plan' })
  expect(store.getV2('run-1').invocations.at(-1)?.message).toBe('Объясни откат: $(touch data)')
})
it('publish_request_stays_a_proposal_until_the_native_owner_publishes_the_exact_draft', async () => {
  const base = { projectId: 'project-1', expectedRuntimeId: 'runtime-v2' }
  await call('pipeline.v2.template.save', {
    ...base,
    requestId: 'save-for-publication',
    expectedRevision: 0,
    draft: pipelineV2TemplateFixture()
  })
  const proposal = {
    ...base,
    requestId: 'publish-request-1',
    draftId: 'development',
    expectedRevision: 1
  }
  expect(await call('pipeline.v2.template.publishRequest', proposal)).toMatchObject({
    ok: true,
    result: { request: { kind: 'publish', state: 'pending', requestId: 'publish-request-1' } }
  })
  expect(await call('pipeline.v2.profiles', base)).toMatchObject({
    ok: true,
    result: { profiles: [] }
  })
  const owner = createPipelineTemplateOwnerActions({
    store,
    assertProject: async () => {},
    wake: () => {}
  })
  await owner.publishTemplate({
    requestId: 'publish-request-1',
    projectId: 'project-1',
    draftId: 'development',
    expectedRevision: 1
  })
  expect(
    await call('pipeline.v2.template.receipt', { ...base, requestId: 'publish-request-1' })
  ).toMatchObject({
    ok: true,
    result: {
      receipt: {
        requestId: 'publish-request-1',
        action: 'published',
        selection: { id: 'development', version: '1', projectId: 'project-1' }
      }
    }
  })
  const record = store.templatesV2.getDraft('project-1', 'development')
  expect(record.revision).toBe(1)
})
import {
  partialRuntimeStore,
  storeRepo
} from '../../../pipelines/testing/pipeline-runtime-store.test-fixture'
