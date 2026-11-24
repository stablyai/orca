import { afterEach, expect, it } from 'vitest'
import { PipelineStore } from '../pipeline-store'
import { pipelineV2AdmissionFixture, settleV2Stage, v2Mutation } from './pipeline-v2.test-fixture'
import { assemblePipelineV2Context } from './pipeline-v2-context'
import { pipelineV2Events } from './pipeline-v2-events'
import { RuntimeClientEventBus } from '../../client/events/runtime-client-event-bus'
import type { RuntimeClientEvent } from '../../../../shared/remote-runtime/session-graph/runtime-client-events'

const stores: PipelineStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))
function create(publish?: (event: RuntimeClientEvent) => void) {
  const store = new PipelineStore(':memory:', publish)
  stores.push(store)
  return store
}
it('mandatory_unicode_input_is_not_silently_trimmed', () => {
  const store = create()
  const admission = pipelineV2AdmissionFixture()
  admission.task = '🔧'.repeat(4800)
  store.createV2(admission)
  const context = assemblePipelineV2Context(store.getV2('run-1'))
  expect(context.task).toBe('🔧'.repeat(4800))
  expect(JSON.stringify(context).length).toBeLessThanOrEqual(16000)
  expect(context.submit.example.command.result.evidence.stage).toBe('generic')
})
it('bounded_context_names_omitted_artifacts_and_fetches_one_by_exact_id', () => {
  const store = create()
  store.createV2(pipelineV2AdmissionFixture())
  settleV2Stage(store)
  settleV2Stage(store)
  const run = store.getV2('run-1')
  const first = run.candidates[0]
  first.summary = 'a'.repeat(11500)
  first.result.summary = first.summary
  run.task = '🔧'.repeat(4800)
  const context = assemblePipelineV2Context(run)
  expect(JSON.stringify(context).length).toBeLessThanOrEqual(16000)
  expect(context.omittedArtifacts).toContain(first.id)
  expect(context.truncated).toBe(true)
  expect(assemblePipelineV2Context(run, { artifactId: first.id }).artifacts[0].summary).toBe(
    'a'.repeat(11500)
  )
  expect(() => assemblePipelineV2Context(run, { artifactId: 'foreign-artifact' })).toThrow(
    'pipeline_artifact_not_found'
  )
})
it('event_cursor_reconnect_is_scoped_to_instance_and_notifies_after_commit', async () => {
  const bus = new RuntimeClientEventBus({
    makeTitleGateKey: (_raw, normalized) => normalized,
    onConsumerAvailabilityChanged: () => {}
  })
  const seen: RuntimeClientEvent[] = []
  const store = create((event) => bus.emit(event))
  bus.on((event) => {
    if (event.type === 'pipelinesChanged') {
      expect(store.getV2(event.runId).revision).toBe(event.revision)
      seen.push(event)
    }
  })
  const admission = pipelineV2AdmissionFixture()
  store.createV2(admission)
  v2Mutation(store, { kind: 'pause' })
  const scope = {
    id: 'run-1',
    workspaceId: admission.workspace.id,
    projectId: 'project-1',
    instanceId: 'instance-1'
  }
  const first = await pipelineV2Events(store, { ...scope, cursor: 0, limit: 1 })
  const second = await pipelineV2Events(store, { ...scope, cursor: first.cursor, limit: 1 })
  expect(first.events.map((event) => event.kind)).toEqual(['create'])
  expect(second.events.map((event) => event.kind)).toEqual(['pause'])
  expect(
    (await pipelineV2Events(store, { ...scope, cursor: second.cursor, limit: 1 })).events
  ).toEqual([])
  await expect(
    pipelineV2Events(store, { ...scope, instanceId: 'replacement', cursor: 0 })
  ).rejects.toThrow('pipeline_workspace_instance_changed')
  await expect(
    pipelineV2Events(store, { ...scope, projectId: 'foreign', cursor: 0 })
  ).rejects.toThrow('pipeline_workspace_instance_changed')
  await expect(pipelineV2Events(store, { ...scope, cursor: 99 })).rejects.toThrow(
    'pipeline_cursor_invalid'
  )
  expect(seen).toMatchObject([
    { type: 'pipelinesChanged', instanceId: 'instance-1', sequence: 1 },
    { type: 'pipelinesChanged', revision: 1, sequence: 2 }
  ])
})
it('long_history_keeps_context_bounded_and_pages_the_omission_index', () => {
  const store = create()
  store.createV2(pipelineV2AdmissionFixture())
  settleV2Stage(store)
  const run = store.getV2('run-1')
  const first = run.candidates[0]
  run.task = '🔧'.repeat(4800)
  run.candidates = [
    first,
    ...Array.from({ length: 80 }, (_, index) => ({
      ...first,
      id: `candidate:${String(index).padStart(64, '0')}`,
      summary: 's'.repeat(3500),
      result: { ...first.result, summary: 's'.repeat(3500) }
    }))
  ]
  const context = assemblePipelineV2Context(run)
  expect(JSON.stringify(context).length).toBeLessThanOrEqual(16000)
  expect(context.omittedCount).toBeGreaterThan(0)
  expect(context.truncated).toBe(true)
  const page = assemblePipelineV2Context(run, { artifactCursor: 2, limit: 1 })
  expect(page.artifacts[0].id).toBe(
    'candidate:0000000000000000000000000000000000000000000000000000000000000001'
  )
  expect(page).toMatchObject({ cursor: 3, hasMore: true })
})
it('pages_real_visit_history_and_reads_the_selected_visit_instead_of_guessing_from_events', () => {
  const store = create()
  store.createV2(pipelineV2AdmissionFixture())
  settleV2Stage(store)
  settleV2Stage(store)
  settleV2Stage(store, 'changes')
  const run = store.getV2('run-1')
  const page = assemblePipelineV2Context(run, { visitCursor: 2, limit: 2 })
  expect(page.visits.map((visit) => ({ stageId: visit.stageId, attempt: visit.attempt }))).toEqual([
    { stageId: 'review', attempt: 0 },
    { stageId: 'plan', attempt: 1 }
  ])
  expect(page).toMatchObject({ cursor: 4, hasMore: false })
  const history = assemblePipelineV2Context(run, { visitId: 'run-1:visit:1' })
  expect(history.visit).toMatchObject({ id: 'run-1:visit:1', stageId: 'plan', state: 'completed' })
  const artifact = assemblePipelineV2Context(run, { artifactId: run.candidates[0].id })
  expect(artifact.artifacts[0]).toMatchObject({
    sessionId: 'primary-session',
    inputRevision: 0,
    sourceRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  })
})
