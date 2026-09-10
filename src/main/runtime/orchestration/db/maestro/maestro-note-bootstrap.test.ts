import { afterEach, describe, expect, it } from 'vitest'
import type { MaestroPrincipal } from '../../../../../shared/maestro-actor'
import type { MaestroWorkspaceAnchor } from '../../../../../shared/maestro-contract'
import { OrchestrationDb } from '../orchestration-db'
import { createMaestroTablesSql } from '../schema/create-maestro-tables-sql'
import { deriveMaestroContextSnapshot } from './maestro-context-snapshot-store'
import { applyMaestroDocumentAuthoringMutation } from './maestro-document-authoring-store'
import { applyMaestroMutation } from './maestro-store'

const openDatabases: OrchestrationDb[] = []

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    db.close()
  }
})

describe('Maestro note bootstrap', () => {
  it('makes a note snapshot pinnable after authoring an empty document', () => {
    const db = new OrchestrationDb(':memory:')
    db.db.exec(createMaestroTablesSql())
    openDatabases.push(db)
    const workspace: MaestroWorkspaceAnchor = {
      repository_id: 'repo-1',
      execution_host_id: 'local',
      workspace_key: 'folder:folder-1',
      run_id: 'run-1'
    }
    const principal: MaestroPrincipal = {
      actor_id: 'coordinator-1',
      kind: 'coordinator',
      authenticated: true,
      session_id: 'session-1',
      workspace,
      generation: 1
    }

    expect(
      applyMaestroDocumentAuthoringMutation.call(
        db,
        {
          schema_version: 1,
          protocol: 'maestro-document-authoring-mutation/v1',
          mutation_id: 'author-note-1',
          scope: workspace,
          expected_revision: 0,
          operation: {
            kind: 'create-note',
            node_id: 'note-1',
            position: { x: 10, y: 20 },
            title: 'Bootstrap note',
            markdown: '# Bootstrap'
          }
        },
        principal
      )
    ).toMatchObject({ outcome: 'applied', revision: 1 })

    const snapshot = deriveMaestroContextSnapshot({
      scope: workspace,
      nodeId: 'note-1',
      noteRevision: 1,
      title: 'Bootstrap note',
      content: '# Bootstrap',
      ownerPrincipal: principal.actor_id
    })
    expect(
      applyMaestroMutation.call(
        db,
        {
          schema_version: 1,
          protocol: 'maestro-mutation/v1',
          mutation_id: 'pin-note-1',
          workspace,
          actor: principal,
          coordinator_generation: 1,
          expected_revision: 1,
          operation: { kind: 'pin-note-snapshot', task_id: 'note-1', snapshot }
        },
        principal
      )
    ).toMatchObject({ outcome: 'applied', revision: 2 })
  })
})
