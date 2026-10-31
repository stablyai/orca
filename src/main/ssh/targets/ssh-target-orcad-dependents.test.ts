import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Repo } from '../../../shared/repo-types'
import { getAllWorktreeMetaForHost } from '../../persistence/loading-store/worktree-identity-metadata'
import { normalizeWorktreeLinkedItemMetadata } from '../../persistence/tracking-repos/worktree-metadata-normalization'

import { collectDependentStateBlockers } from './ssh-target-orcad-dependents'
import { emptyDependentStateStore } from './ssh-target-orcad-dependents-fixture'
import { orcadTargetBlockerMessage } from './ssh-target-orcad-claims'

function blockersFor(overrides: Parameters<typeof emptyDependentStateStore>[0]) {
  return collectDependentStateBlockers(emptyDependentStateStore(overrides), 'ssh-1')
}

describe('client state that still references an SSH target', () => {
  describe('profiles with unstamped metadata rows from an older build (#31498)', () => {
    const SETUP_TERMINAL_ID = 'ephemeral-setup-terminal:panel-1'
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the census reads only id, connectionId and executionHostId.
    const repos = [
      { id: 'local-repo', connectionId: null },
      { id: 'ssh-repo', connectionId: 'ssh-1' }
    ] as Repo[]

    function legacyProfile(): PersistedState {
      const row = { displayName: '', comment: '', isUnread: false, sortOrder: 1, lastActivityAt: 1 }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the load normalizer and host projection read only these maps.
      return {
        repos,
        worktreeMeta: {
          [FLOATING_TERMINAL_WORKTREE_ID]: {
            ...row,
            instanceId: '11111111-1111-4111-8111-111111111111',
            workspaceStatus: 'in-progress'
          },
          [SETUP_TERMINAL_ID]: { ...row },
          'local-repo::/home/me/app': { ...row },
          'removed-repo::/srv/old': { ...row },
          'project-1::/srv/project': { ...row },
          'ssh-repo::/srv/app': { ...row }
        },
        worktreeMetaByIdentity: {},
        worktreeIdentityAliases: {},
        worktreeLineageById: {},
        workspaceLineageByChildKey: {}
      } as unknown as PersistedState
    }

    function metadataBlockerNames(state: PersistedState): string[] | undefined {
      const [blocker] = blockersFor({
        getRepos: () => repos,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the census reads only project ids.
        getProjects: () => [{ id: 'project-1' }] as never,
        getAllWorktreeMetaForHost: (hostId) => getAllWorktreeMetaForHost({ state }, hostId)
      })
      return blocker?.code === 'orcad_migration_dependent_state'
        ? blocker.dependencies.flatMap((dependency) => dependency.names ?? [])
        : undefined
    }

    it('counts only rows its repo or a project may own, before and after the load stamps them', () => {
      const state = legacyProfile()
      const owned = ['project-1::/srv/project', 'ssh-repo::/srv/app']
      expect(metadataBlockerNames(state)).toEqual(owned)

      expect(normalizeWorktreeLinkedItemMetadata(state)).toBe(true)
      expect(state.worktreeMeta[FLOATING_TERMINAL_WORKTREE_ID]?.hostId).toBe('local')
      expect(state.worktreeMeta[SETUP_TERMINAL_ID]?.hostId).toBe('local')
      expect(state.worktreeMeta['ssh-repo::/srv/app']?.hostId).toBeUndefined()
      expect(metadataBlockerNames(state)).toEqual(owned)
    })

    it('blocks an unrelated SSH target on neither the floating terminal row nor an orphan', () => {
      const state = legacyProfile()
      delete state.worktreeMeta['ssh-repo::/srv/app']
      delete state.worktreeMeta['project-1::/srv/project']
      expect(metadataBlockerNames(state)).toBeUndefined()
      expect(getAllWorktreeMetaForHost({ state }, 'local')).toHaveProperty(
        FLOATING_TERMINAL_WORKTREE_ID
      )
    })
  })

  it('refuses as unverifiable when a store cannot be read, naming the store', () => {
    const blockers = blockersFor({
      listAutomations: () => {
        throw new Error('automations unreadable')
      },
      getAllWorktreeMetaForHost: () => {
        throw new Error('meta unreadable')
      }
    })
    expect(blockers).toEqual([
      {
        code: 'orcad_migration_dependency_unverifiable',
        category: 'live-or-unverifiable',
        sources: ['automation', 'worktree-metadata']
      }
    ])
    const [blocker] = blockers
    expect(blocker && orcadTargetBlockerMessage('ssh-1', blocker)).toContain(
      'could not read its saved automation, worktree-metadata state'
    )
  })
})
