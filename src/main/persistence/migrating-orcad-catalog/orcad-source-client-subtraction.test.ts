import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration-manifest'
import { orcadMigrationCutoverFixture } from '../../ssh/orcad-migration-cutover-fixture'
import { subtractOrcadMigrationClientState } from './orcad-source-client-subtraction'

const worktreeId = 'repo-1::/srv/worktree'

function manifest(): OrcadMigrationManifest {
  const base = orcadMigrationCutoverFixture('m-1', 'target-1', {
    environmentId: 'environment-1'
  }).manifest
  return {
    ...base,
    payload: {
      ...base.payload,
      dormantState: {
        version: 1,
        worktreeMeta: [],
        worktreeLineage: [],
        workspaceLineage: [],
        sparsePresets: [],
        retiredWorktreeNames: [],
        retiredWorktreeNamespaces: [],
        clientState: {
          clientHostedBrowserCloseIntents: [
            { sourceEnvironmentId: 'old', browserPageId: 'page-1', worktreeId, closedAt: 42 },
            { sourceEnvironmentId: 'old', browserPageId: 'page-2', worktreeId, closedAt: 43 }
          ]
        }
      }
    }
  }
}

describe('retiring client-hosted browser close intents', () => {
  it('finishes a retry after the moving write already flushed', () => {
    const state = getDefaultPersistedState('/home/test')
    state.workspaceSession.clientHostedBrowserCloseIntentsByEnvironment = {
      old: [
        { browserPageId: 'page-1', worktreeId, closedAt: 42 },
        { browserPageId: 'page-2', worktreeId, closedAt: 43 }
      ]
    }
    subtractOrcadMigrationClientState(state, manifest())
    const moved = structuredClone(
      state.workspaceSession.clientHostedBrowserCloseIntentsByEnvironment
    )
    expect(() => subtractOrcadMigrationClientState(state, manifest())).not.toThrow()
    expect(state.workspaceSession.clientHostedBrowserCloseIntentsByEnvironment).toEqual(moved)
  })

  it('still refuses a source intent that is gone without reaching the destination', () => {
    const state = getDefaultPersistedState('/home/test')
    state.workspaceSession.clientHostedBrowserCloseIntentsByEnvironment = {
      old: [{ browserPageId: 'page-2', worktreeId, closedAt: 43 }],
      'environment-1': [{ browserPageId: 'page-1', worktreeId, closedAt: 99 }]
    }
    expect(() => subtractOrcadMigrationClientState(state, manifest())).toThrow(
      'orcad_migration_source_close_intent_changed'
    )
  })
})
