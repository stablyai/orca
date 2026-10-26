import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeAgentOrchestrationProjection } from './runtime-agent-orchestration-projection'
import { RuntimeExternalParentLinks } from './runtime-external-parent-links'
import { makeTuiIdleLeaf, makeTuiIdlePty } from './tui-idle-wait-test-harness'
import { OrchestrationDb } from './orchestration/db'
import { createRootDispatch } from './orchestration/db/root-dispatch-test-fixture'

const childPane = 'child:22222222-2222-4222-8222-222222222222'
const parentPane = 'root:11111111-1111-4111-8111-111111111111'
const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function fixture(db: OrchestrationDb | null) {
  const links = new RuntimeExternalParentLinks()
  const child = makeTuiIdleLeaf({ ptyId: 'child-pty', connected: true })
  const parent = makeTuiIdlePty({ paneKey: 'stale:legacy-copy', connected: true })
  const handles = new Map([
    [childPane, 'child-handle'],
    [parentPane, 'root-handle']
  ])
  const projection = new RuntimeAgentOrchestrationProjection({
    getDb: () => db,
    getLeaves: () => [child],
    getPtys: () => [parent],
    paneOf: () => ({ tabId: 'root', paneKey: parentPane, recordedAtGraphSequence: 0 }),
    issueLeafHandle: () => 'child-handle',
    issuePtyHandle: () => 'root-handle',
    makePaneKey: () => childPane,
    getWorktreeId: () => 'wt-1',
    getHandleForPaneKey: (key) => handles.get(key) ?? null,
    getPaneKey: (handle) => (handle === 'root-handle' ? parentPane : childPane),
    getDispatchAuthority: () => null,
    getAgentStatusSnapshot: () => [],
    getExternalParentLinks: () => links.entries()
  })
  links.set(childPane, {
    parentPaneKey: parentPane,
    taskId: 'jcode-spawn:piglet',
    displayName: 'Piglet'
  })
  return { links, child, handles, projection }
}

describe('external parent orchestration projection', () => {
  it.each(['no database', 'empty database'])('projects live child with %s', (mode) => {
    const db = mode === 'empty database' ? new OrchestrationDb(':memory:') : null
    if (db) {
      databases.push(db)
    }
    const h = fixture(db)
    expect(h.projection.buildByPaneKey()).toEqual({
      [childPane]: {
        taskId: 'jcode-spawn:piglet',
        dispatchId: 'jcode-spawn:piglet',
        parentPaneKey: parentPane,
        parentTerminalHandle: 'root-handle',
        displayName: 'Piglet'
      }
    })
    h.child.connected = false
    expect(h.projection.buildByPaneKey()).toBeUndefined()
    h.child.connected = true
    h.child.ptyId = null
    expect(h.projection.buildByPaneKey()).toBeUndefined()
  })

  it('retains parent key without publishing stale parent handle', () => {
    const h = fixture(null)
    h.handles.delete(parentPane)
    expect(h.projection.buildByPaneKey()?.[childPane]).toEqual({
      taskId: 'jcode-spawn:piglet',
      dispatchId: 'jcode-spawn:piglet',
      parentPaneKey: parentPane,
      displayName: 'Piglet'
    })
    h.links.delete(childPane)
    expect(h.projection.buildByPaneKey()).toBeUndefined()
  })

  it('keeps real DB contexts, including precedence on same child', () => {
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    const run = db.createRun({
      objective: 'keep DB context',
      coordinatorHandle: 'root-handle',
      coordinatorPaneKey: parentPane
    })
    const task = db.createTask({ spec: 'ship task', runId: run.id })
    createRootDispatch(db, task.id, 'child-handle', childPane)
    const h = fixture(db)
    h.links.delete(childPane)
    const baseline = h.projection.buildByPaneKey()
    expect(baseline?.[childPane].dispatchStatus).toBeDefined()
    h.links.set('unrelated:leaf', { parentPaneKey: parentPane, taskId: 'unrelated' })
    expect(h.projection.buildByPaneKey()).toEqual(baseline)
    h.links.set(childPane, { parentPaneKey: 'foreign:leaf', taskId: 'jcode-spawn:other' })
    expect(h.projection.buildByPaneKey()).toEqual(baseline)
  })
})
