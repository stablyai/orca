import { afterEach } from 'vitest'
import { OrchestrationDb } from '../db'
import type { CrewReadDependencies } from './crew-read-model'
const opened: OrchestrationDb[] = []
afterEach(() => opened.splice(0).forEach((db) => db.close()))
export function fixture() {
  const db = new OrchestrationDb(':memory:')
  opened.push(db)
  const handles = new Map(
    ['coord', 'worker', 'helper', 'grandchild', 'peer', 'outbound'].map((name) => [
      `term_${name}`,
      `tab_${name}:aaaaaaaa-aaaa-4aaa-8aaa-${name.padEnd(12, 'a')}`
    ])
  )
  const deps: CrewReadDependencies = {
    db,
    retainedDbExists: true,
    hostKey: 'test-host',
    records: null,
    statuses: [],
    maxDepth: () => 10,
    callerProjection: (handle) => ({
      kind: 'terminal',
      handle,
      paneKey: handles.get(handle),
      processIncarnation: handles.has(handle) ? `process:${handle}` : undefined
    }),
    liveHandle: (handle) => handles.has(handle),
    handleForPane: (pane) => [...handles].find(([, value]) => value === pane)?.[0] ?? null,
    paneForHandle: (handle) => handles.get(handle) ?? null,
    livePaneForHandle: (handle) => handles.get(handle) ?? null,
    processForHandle: (handle) => (handles.has(handle) ? `process:${handle}` : null),
    name: (_identity, task) => task ?? 'Duplicate name'
  }
  const run = db.createRun({
    objective: 'Crew',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: handles.get('term_coord')!
  })
  const assign = (handle: string, creator = 'term_coord', title = 'Implement crew') => {
    const task = db.createTask({ runId: run.id, spec: title, taskTitle: title })
    db.updateTaskStatus(task.id, 'ready')
    return db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: handle,
      assigneePaneKey: handles.get(handle),
      creator: { kind: 'terminal', handle: creator, paneKey: handles.get(creator) },
      maxDepth: 10
    })
  }
  return { db, deps, run, assign, handles }
}
