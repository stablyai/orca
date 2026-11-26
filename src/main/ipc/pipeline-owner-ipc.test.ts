import type { WebContents } from 'electron'
type TestSender = Pick<WebContents, 'id' | 'isDestroyed' | 'getType' | 'getURL'>
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PipelineStore } from '../runtime/pipelines/pipeline-store'
import {
  fixtureSource,
  gatedV2Template,
  pipelineV2AdmissionFixture,
  settleV2Stage
} from '../runtime/pipelines/v2/pipeline-v2.test-fixture'
import { createPipelineOwnerActions } from '../runtime/pipelines/v2/pipeline-v2-owner-actions'
import {
  registerPipelineOwnerHandlers,
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
let source = fixtureSource
let runtimeId = 'runtime-owner'
beforeEach(() => {
  store = new PipelineStore(':memory:')
  source = fixtureSource
  runtimeId = 'runtime-owner'
  store.createV2(pipelineV2AdmissionFixture(gatedV2Template()))
  settleV2Stage(store)
  const actions = createPipelineOwnerActions({
    store,
    assertWorkspace: async () => {},
    sourceRevision: async () => source,
    wake: () => {},
    getRuntimeId: () => runtimeId
  })
  setTrustedPipelineRendererWebContentsId(7)
  registerPipelineOwnerHandlers(() => actions)
})
afterEach(() => store.close())
const sender = (id: number, type: 'window' | 'webview' = 'window'): TestSender => ({
  id,
  isDestroyed: () => false,
  getType: () => type,
  getURL: () => 'file:///orca/index.html'
})
function input() {
  const run = store.getV2('run-1')
  return {
    id: run.id,
    workspaceId: run.workspace.id,
    projectId: run.workspace.projectId,
    expectedRuntimeId: 'runtime-owner',
    mutation: {
      requestId: 'owner-accept',
      expectedRevision: run.revision,
      expectedInstanceId: run.workspace.instanceId,
      command: { kind: 'decide' as const, ...run.pendingDecision!, action: 'accept' as const }
    }
  }
}
it('untrusted_renderer_cannot_resolve', async () => {
  await expect(
    handlers.get('pipelineOwner:resolveDecision')!({ sender: sender(8) }, input())
  ).rejects.toThrow('pipeline_owner_required')
  expect(store.getV2('run-1').state).toBe('waiting_owner')
})
it('worker_rpc_cannot_resolve', async () => {
  await expect(
    handlers.get('pipelineOwner:resolveDecision')!(
      { sender: sender(7, 'webview') },
      { ...input(), client: { type: 'owner' } }
    )
  ).rejects.toThrow('pipeline_owner_required')
  expect(store.getV2('run-1').stageId).toBe('plan')
})
it('trusted_pinned_renderer_accepts_once', async () => {
  const request = input()
  const invoke = (value: unknown) =>
    handlers.get('pipelineOwner:resolveDecision')!({ sender: sender(7) }, value)
  const receipt = await invoke(request)
  expect(receipt).toMatchObject({
    kind: 'decide',
    state: 'running',
    stageId: 'implement',
    acceptedRevision: 5
  })
  expect(await invoke(request)).toEqual(receipt)
  await expect(
    invoke({
      ...request,
      mutation: {
        ...request.mutation,
        command: { ...request.mutation.command, action: 'rework', comment: 'Revise the plan' }
      }
    })
  ).rejects.toThrow('pipeline_request_conflict')
  expect(store.getV2('run-1').visits.map((value) => value.stageId)).toEqual(['plan', 'implement'])
})
it('source_or_candidate_change_rejects_click', async () => {
  const request = input()
  source = 'b'.repeat(64)
  await expect(
    handlers.get('pipelineOwner:resolveDecision')!({ sender: sender(7) }, request)
  ).rejects.toThrow('pipeline_source_changed')
  expect(store.getV2('run-1').state).toBe('waiting_owner')
})
it('rejects an owner decision and budget extension captured from a previous runtime', async () => {
  const before = store.getV2('run-1')
  runtimeId = 'runtime-restarted'
  await expect(
    handlers.get('pipelineOwner:resolveDecision')!(
      { sender: sender(7) },
      { ...input(), expectedRuntimeId: 'runtime-owner' }
    )
  ).rejects.toThrow('pipeline_runtime_identity_changed')
  await expect(
    handlers.get('pipelineOwner:resolveBudget')!(
      { sender: sender(7) },
      {
        ...input(),
        expectedRuntimeId: 'runtime-owner',
        mutation: {
          requestId: 'old-runtime-budget',
          expectedRevision: before.revision,
          expectedInstanceId: before.workspace.instanceId,
          command: { kind: 'extend_budget', maxInvocations: 150 }
        }
      }
    )
  ).rejects.toThrow('pipeline_runtime_identity_changed')
  expect(store.getV2('run-1').revision).toBe(before.revision)
  expect(store.receiptV2('run-1', 'old-runtime-budget')).toBeNull()
})
it('missing_pinned_window_never_uses_development_origin_fallback', async () => {
  setTrustedPipelineRendererWebContentsId(null)
  await expect(
    handlers.get('pipelineOwner:resolveDecision')!({ sender: sender(7) }, input())
  ).rejects.toThrow('pipeline_owner_required')
})
