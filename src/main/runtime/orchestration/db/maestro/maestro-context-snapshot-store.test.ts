import { describe, expect, it } from 'vitest'
import type { MaestroPrincipal } from '../../../../../shared/maestro-actor'
import { OrchestrationDb } from '../orchestration-db'

describe('Maestro context snapshot store', () => {
  it('computes and preserves immutable content across note revisions and reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'maestro-snapshot-'))
    const databasePath = join(directory, 'maestro.sqlite')
    const db = new OrchestrationDb(databasePath)
    const run = db.createRun({
      objective: 'Snapshot test',
      coordinatorHandle: 'coordinator-1',
      coordinatorPaneKey: 'tab-1:leaf-1'
    })
    const scope = {
      execution_host_id: 'native',
      workspace_key: 'folder:folder-1',
      run_id: run.id
    }
    const coordinator: MaestroPrincipal = {
      actor_id: 'coordinator-1',
      kind: 'coordinator',
      authenticated: true,
      session_id: 'session-1',
      generation: run.consumer_generation,
      workspace: scope
    }
    const firstId = db.pinMaestroContextSnapshot({
      scope,
      nodeId: 'note-1',
      noteRevision: 1,
      title: 'Pinned context',
      content: '# First',
      ownerPrincipal: 'user-1'
    })
    const secondId = db.pinMaestroContextSnapshot({
      scope,
      nodeId: 'note-1',
      noteRevision: 2,
      title: 'Pinned context',
      content: '# Second',
      ownerPrincipal: 'user-1'
    })

    expect(secondId).not.toBe(firstId)
    expect(db.getMaestroContextSnapshot(firstId, coordinator)?.snapshot).toMatchObject({
      revision: 'note-1',
      snapshot_path: 'maestro/context/note-1/1.md'
    })
    expect(db.getMaestroContextSnapshot(firstId, coordinator)?.markdown).toBe('# First')
    db.close()

    const reopened = new OrchestrationDb(databasePath)
    expect(reopened.getMaestroContextSnapshot(firstId, coordinator)?.markdown).toBe('# First')
    reopened.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('returns inaccessible and released snapshots as unavailable', () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Snapshot access test',
      coordinatorHandle: 'coordinator-2',
      coordinatorPaneKey: 'tab-2:leaf-2'
    })
    const scope = {
      execution_host_id: 'native',
      workspace_key: 'folder:folder-2',
      run_id: run.id
    }
    const coordinator: MaestroPrincipal = {
      actor_id: 'coordinator-2',
      kind: 'coordinator',
      authenticated: true,
      session_id: 'session-2',
      generation: run.consumer_generation,
      workspace: scope
    }
    const snapshotId = db.pinMaestroContextSnapshot({
      scope,
      nodeId: 'note-1',
      noteRevision: 1,
      title: 'Pinned context',
      content: '# Context',
      ownerPrincipal: 'user-2'
    })

    expect(
      db.getMaestroContextSnapshot(snapshotId, { ...coordinator, generation: 99 })
    ).toBeUndefined()
    expect(db.releaseMaestroContextSnapshot(snapshotId, coordinator)).toBe(true)
    expect(db.getMaestroContextSnapshot(snapshotId, coordinator)).toBeUndefined()
    db.close()
  })
})
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
