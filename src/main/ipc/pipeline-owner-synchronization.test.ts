import type { WebContents } from 'electron'
type TestSender = Pick<WebContents, 'id' | 'isDestroyed' | 'getType' | 'getURL'>
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PipelineStore } from '../runtime/pipelines/pipeline-store'
import { PipelineController } from '../runtime/pipelines/pipeline-controller'
import {
  fixtureSource,
  gatedV2Template,
  pipelineV2AdmissionFixture,
  settleV2Stage
} from '../runtime/pipelines/v2/pipeline-v2.test-fixture'
import {
  registerPipelineSessionHandlers,
  setTrustedPipelineRendererWebContentsId
} from './pipeline-owner-ipc'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: TestSender }, input: unknown) => Promise<unknown>>()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: never) => handlers.set(channel, handler) }
}))
let store: PipelineStore
let runtimeId: string
let validateWorkspace: () => Promise<void>
beforeEach(() => {
  store = new PipelineStore(':memory:')
  const template = gatedV2Template()
  const stage = template.stages[0]
  if (stage.kind === 'agent') {
    stage.independent = true
  }
  store.createV2(pipelineV2AdmissionFixture(template))
  settleV2Stage(store)
  runtimeId = 'runtime-sync'
  validateWorkspace = async () => {}
  const ports = {
    sourceRevision: async () => fixtureSource,
    reviewCommit: async () => 'b'.repeat(40),
    settled: async () => false,
    checks: async () => ({ category: 'passed' as const, body: 'ok', results: [] }),
    startInvocation: async () => {
      throw new Error('Unexpected launch')
    }
  }
  const controller = new PipelineController(
    store,
    {
      ...ports,
      start: async () => {
        throw new Error('Unexpected legacy launch')
      },
      checks: async () => ({ passed: true, body: 'ok' })
    },
    ports
  )
  const service = {
    store,
    controller,
    v2Ports: ports,
    assertWorkspace: () => validateWorkspace(),
    wake: () => {}
  }
  setTrustedPipelineRendererWebContentsId(7)
  registerPipelineSessionHandlers(
    () => service,
    () => runtimeId
  )
})
afterEach(() => store.close())
function input() {
  const run = store.getV2('run-1')
  return {
    id: run.id,
    requestId: 'synchronize-owner',
    expectedRuntimeId: 'runtime-sync',
    expectedInstanceId: 'instance-1',
    expectedRevision: run.revision,
    pin: run.pendingDecision!,
    message: 'Assess the changed source'
  }
}
function synchronize(value: unknown) {
  return handlers.get('pipelineOwner:synchronize')!(
    {
      sender: {
        id: 7,
        isDestroyed: () => false,
        getType: () => 'window',
        getURL: () => 'file:///orca/index.html'
      }
    },
    value
  )
}
it('rejects synchronization captured before runtime restart without reserving work', async () => {
  const request = input()
  runtimeId = 'runtime-restarted'
  await expect(synchronize(request)).rejects.toThrow('pipeline_runtime_identity_changed')
  expect(store.receiptV2('run-1', request.requestId)).toBeNull()
  expect(store.getV2('run-1').usedInvocations).toBe(1)
})
it('rejects a runtime change while checking the workspace before reserving work', async () => {
  const request = input()
  validateWorkspace = async () => {
    runtimeId = 'runtime-restarted'
  }
  await expect(synchronize(request)).rejects.toThrow('pipeline_runtime_identity_changed')
  expect(store.receiptV2('run-1', request.requestId)).toBeNull()
})
it('pins the independent review commit when synchronizing through the native owner bridge', async () => {
  const result = await synchronize(input())
  expect(result).toMatchObject({ state: 'outcome_unknown' })
  expect(store.getV2('run-1').invocations.at(-1)).toMatchObject({
    purpose: 'synchronize',
    reviewCommit: 'b'.repeat(40)
  })
})
