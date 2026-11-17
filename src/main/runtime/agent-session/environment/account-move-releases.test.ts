import { afterEach, expect, it } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import '../../orchestration/db/contract-constants'
import '../../orchestration/db/messages/mailbox-routing-page'
import '../../orchestration/db/dispatch-row-writer'
import '../../orchestration/db/attempt-outcome-projection'
import { structuredWorkerIncarnation } from '../../orchestration/terminal-authority/structured-sessions/structured-worker-custody'
import {
  takeStructuredWorkerDispatchEnds,
  watchStructuredWorkerDispatchEnds
} from '../../orchestration/terminal-authority/structured-sessions/structured-worker-dispatch-closes'
import type { StructuredAgentSessionAccountMoveEdge } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import { accountMoveReleases } from './account-move-releases'

let db: OrchestrationDb | undefined
afterEach(() => db?.close())

it('raises one Dispatch edge naming the worker when its Dispatch completes, and none for other orchestration writes', () => {
  const orchestration = (db = new OrchestrationDb(':memory:'))
  const run = orchestration.createRun({
    objective: 'workers',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: 'tab_coordinator:dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  })
  const task = orchestration.createTask({ runId: run.id, spec: 'work' })
  const dispatch = orchestration.createDispatchContext({
    taskId: task.id,
    assigneeHandle: 'term_worker',
    creator: { kind: 'system' },
    maxDepth: 9
  })
  const key = structuredWorkerIncarnation('worker-a')
  orchestration.db
    .prepare('UPDATE dispatch_contexts SET process_incarnation = ? WHERE id = ?')
    .run(key, dispatch.id)
  const releases = accountMoveReleases(orchestration.crewChanges, () => null, {
    watch: () => watchStructuredWorkerDispatchEnds(orchestration),
    take: () => takeStructuredWorkerDispatchEnds(orchestration),
    key: structuredWorkerIncarnation
  })
  const edges: StructuredAgentSessionAccountMoveEdge[] = []
  releases.subscribe((edge) => edges.push(edge))

  orchestration.createTask({ runId: run.id, spec: 'unrelated' })
  orchestration.insertMessage({ runId: run.id, from: 'worker', to: `run:${run.id}`, subject: 'hi' })
  expect(edges).toEqual([])

  orchestration.completeDispatch(dispatch.id)
  expect(edges).toEqual([{ kind: 'dispatch', ended: [releases.dispatchKey!('worker-a')] }])
})
