import { vi } from 'vitest'
import { RpcDispatcher } from '../../dispatcher'
import { PIPELINE_METHODS } from './pipelines'
import { PipelineStore } from '../../../pipelines/pipeline-store'
import {
  gatedV2Template,
  pipelineV2AdmissionFixture,
  fixtureSource
} from '../../../pipelines/v2/pipeline-v2.test-fixture'
import { createSessionCallerHarness } from '../../../pipelines/testing/pipeline-session-caller.test-fixture'
import { PipelineController } from '../../../pipelines/pipeline-controller'
import type { PipelineV2Ports } from '../../../pipelines/v2/pipeline-v2-execution'
import {
  partialRuntimeStore,
  storeRepo
} from '../../../pipelines/testing/pipeline-runtime-store.test-fixture'

export function createPipelineV2RpcTestHarness(hostRef: { current: unknown }) {
  const h = createSessionCallerHarness(hostRef)
  const store = new PipelineStore(':memory:')
  store.createV2(pipelineV2AdmissionFixture(gatedV2Template()))
  const ports: PipelineV2Ports = {
    sourceRevision: async () => fixtureSource,
    reviewCommit: async () => 'b'.repeat(40),
    settled: async () => false,
    checks: async () => {
      throw new Error('Unexpected checks')
    },
    startInvocation: async (request, _spec, prepared) => {
      const binding = { dispatchId: 'discuss-1', session: request.previousSession! }
      prepared(binding)
      return { state: 'ready', ...binding }
    }
  }
  const controller = new PipelineController(
    store,
    {
      sourceRevision: ports.sourceRevision,
      reviewCommit: ports.reviewCommit,
      settled: ports.settled,
      start: async () => {
        throw new Error('Unexpected legacy worker')
      },
      checks: async () => {
        throw new Error('Unexpected legacy checks')
      }
    },
    ports
  )
  Object.defineProperty(h.runtime, 'pipelineRuntime', {
    value: { store, controller, assertWorkspace: async () => {}, v2Ports: ports, wake: () => {} }
  })
  vi.spyOn(h.runtime, 'getRuntimeId').mockReturnValue('runtime-v2')
  vi.spyOn(h.runtime, 'requireStore').mockReturnValue(
    partialRuntimeStore({
      getRepo: (id: string) =>
        id === 'project-1' ? storeRepo({ id, path: '/project', kind: 'git' }) : undefined
    })
  )
  const dispatcher = new RpcDispatcher({ runtime: h.runtime, methods: PIPELINE_METHODS })
  return { h, store, ports, dispatcher }
}
