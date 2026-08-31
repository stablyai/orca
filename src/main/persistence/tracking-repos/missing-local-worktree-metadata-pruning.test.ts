import { describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../shared/constants'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Project } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import {
  captureNativeLocalWorktreeMetadataScanExpectation,
  pruneSessionlessMissingLocalWorktreeMetadataForRepo
} from './missing-local-worktree-metadata-pruning'

const REPO_ID = 'repo-1'
const LIVE_ID = `${REPO_ID}::/workspace/live`

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: REPO_ID,
    path: '/workspace/repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

function makeMeta(worktreeId: string): WorktreeMeta {
  return {
    instanceId: `instance-${worktreeId}`,
    hostId: 'local',
    displayName: worktreeId,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

function makeState(repo = makeRepo()): PersistedState {
  const state = getDefaultPersistedState('/home/test')
  state.repos = [repo]
  return state
}

function capture(state: PersistedState, repo = state.repos[0]!) {
  return captureNativeLocalWorktreeMetadataScanExpectation(state, repo)
}

function pruneCaptured(
  state: PersistedState,
  scan: ReturnType<typeof capture>,
  ids: readonly string[],
  platform?: NodeJS.Platform
): string[] {
  const wanted = new Set(ids)
  return pruneSessionlessMissingLocalWorktreeMetadataForRepo(
    state,
    scan,
    scan.metadata.filter(({ worktreeId }) => wanted.has(worktreeId)),
    platform
  )
}

describe('pruneSessionlessMissingLocalWorktreeMetadataForRepo', () => {
  it('removes 2,709 sessionless rows in one batch without cloning or changing session state', () => {
    const state = makeState()
    const staleIds = Array.from(
      { length: 2_709 },
      (_, index) => `${REPO_ID}::/workspace/stale-${index}`
    )
    const allIds = [LIVE_ID, ...staleIds]
    state.worktreeMetaByIdentity = {}
    state.worktreeIdentityAliases = {}
    for (const [index, worktreeId] of allIds.entries()) {
      const meta = makeMeta(worktreeId)
      const identityKey = `identity-${index}`
      state.worktreeMeta[worktreeId] = meta
      state.worktreeMetaByIdentity[identityKey] = meta
      state.worktreeIdentityAliases[`local|${worktreeId}`] = [identityKey]
    }
    state.worktreeLineageById[staleIds[0]!] = { worktreeId: staleIds[0] } as never
    state.workspaceLineageByChildKey[worktreeWorkspaceKey(staleIds[0]!)] = {
      childWorkspaceKey: worktreeWorkspaceKey(staleIds[0]!)
    } as never
    state.workspaceSession.terminalTopologyRevisionByRepoId = { [REPO_ID]: 7 }
    const hostSession = {
      ...getDefaultWorkspaceSession(),
      terminalTopologyRevisionByRepoId: { [REPO_ID]: 11 }
    }
    state.workspaceSessionsByHostId = { 'runtime:mirror': hostSession }
    const scan = capture(state)
    const session = state.workspaceSession
    const sessionSnapshot = structuredClone(session)
    const hostSessionSnapshot = structuredClone(hostSession)
    const cloneSpy = vi.spyOn(globalThis, 'structuredClone')

    const removed = pruneCaptured(state, scan, staleIds)

    expect(removed).toHaveLength(staleIds.length)
    expect(cloneSpy).not.toHaveBeenCalled()
    cloneSpy.mockRestore()
    expect(Object.keys(state.worktreeMeta)).toEqual([LIVE_ID])
    expect(Object.keys(state.worktreeMetaByIdentity ?? {})).toEqual(['identity-0'])
    expect(Object.keys(state.worktreeIdentityAliases ?? {})).toEqual([`local|${LIVE_ID}`])
    expect(state.worktreeLineageById[staleIds[0]!]).toBeUndefined()
    expect(state.workspaceLineageByChildKey[worktreeWorkspaceKey(staleIds[0]!)]).toBeUndefined()
    expect(state.workspaceSession).toBe(session)
    expect(state.workspaceSession).toEqual(sessionSnapshot)
    expect(state.workspaceSessionsByHostId?.['runtime:mirror']).toBe(hostSession)
    expect(state.workspaceSessionsByHostId?.['runtime:mirror']).toEqual(hostSessionSnapshot)
  })

  it('fails closed when metadata is mutated or replaced after the scan starts', () => {
    const inPlaceState = makeState()
    const inPlaceId = `${REPO_ID}::/workspace/in-place`
    inPlaceState.worktreeMeta[inPlaceId] = makeMeta(inPlaceId)
    const inPlaceScan = capture(inPlaceState)
    inPlaceState.worktreeMeta[inPlaceId]!.instanceId = 'replacement-instance'

    expect(pruneCaptured(inPlaceState, inPlaceScan, [inPlaceId])).toEqual([])

    const replacedState = makeState()
    const replacedId = `${REPO_ID}::/workspace/replaced`
    const original = makeMeta(replacedId)
    replacedState.worktreeMeta[replacedId] = original
    const replacedScan = capture(replacedState)
    replacedState.worktreeMeta[replacedId] = { ...original }

    expect(pruneCaptured(replacedState, replacedScan, [replacedId])).toEqual([])
    expect(replacedState.worktreeMeta[replacedId]).not.toBe(original)
  })

  it('fails closed when an identical repo row is removed and re-added during the scan', () => {
    const state = makeState()
    const worktreeId = `${REPO_ID}::/workspace/re-added-repo`
    state.worktreeMeta[worktreeId] = makeMeta(worktreeId)
    const scan = capture(state)
    const replacement = { ...state.repos[0]! }
    state.repos.splice(0, 1, replacement)

    expect(pruneCaptured(state, scan, [worktreeId])).toEqual([])
    expect(state.repos[0]).toBe(replacement)
    expect(state.worktreeMeta[worktreeId]).toBeDefined()
  })

  it('uses the effective Git kind when the raw legacy repo omitted kind', () => {
    const state = makeState()
    const worktreeId = `${REPO_ID}::/workspace/legacy-git-kind`
    const rawRepo = state.repos[0]!
    state.worktreeMeta[worktreeId] = makeMeta(worktreeId)
    const scan = capture(state, { ...rawRepo, kind: 'git' })

    expect(rawRepo.kind).toBeUndefined()
    expect(pruneCaptured(state, scan, [worktreeId])).toEqual([worktreeId])
  })

  it.each([
    'tabsByWorktree',
    'browserTabsByWorktree',
    'openFilesByWorktree',
    'activeFileIdByWorktree',
    'activeBrowserTabIdByWorktree',
    'clientHostedBrowserPagesByWorktree',
    'activeTabTypeByWorktree',
    'activeTabIdByWorktree',
    'unifiedTabs',
    'tabGroups',
    'tabGroupLayouts',
    'activeGroupIdByWorktree',
    'lastVisitedAtByWorktreeId',
    'defaultTerminalTabsAppliedByWorktreeId'
  ] as const)('preserves an owner named by workspaceSession.%s', (field) => {
    const state = makeState()
    const worktreeId = `${REPO_ID}::/workspace/${field}`
    state.worktreeMeta[worktreeId] = makeMeta(worktreeId)
    const scan = capture(state)
    const ownerKey = field === 'lastVisitedAtByWorktreeId' ? `local|${worktreeId}` : worktreeId
    ;(state.workspaceSession as unknown as Record<string, unknown>)[field] = {
      [ownerKey]: []
    }

    expect(pruneCaptured(state, scan, [worktreeId])).toEqual([])
    expect(state.worktreeMeta[worktreeId]).toBeDefined()
  })

  it('preserves scalar, nested, remote-partition, mobile, and relay recovery owners', () => {
    const ownerMutations: ((state: PersistedState, worktreeId: string) => void)[] = [
      (state, worktreeId) => {
        state.workspaceSession.activeWorktreeId = worktreeId
      },
      (state, worktreeId) => {
        state.workspaceSession.activeWorkspaceKey = worktreeWorkspaceKey(worktreeId)
      },
      (state, worktreeId) => {
        state.workspaceSession.activeWorktreeIdsOnShutdown = [worktreeId]
      },
      (state, worktreeId) => {
        state.ui.lastActiveWorktreeId = worktreeId
      },
      (state, worktreeId) => {
        state.workspaceSession.sleepingAgentSessionsByPaneKey = {
          pane: { worktreeId } as never
        }
      },
      (state, worktreeId) => {
        state.workspaceSession.terminalSurfaceTombstonesByPaneKey = {
          pane: { worktreeId } as never
        }
      },
      (state, worktreeId) => {
        state.workspaceSession.closedTerminalTabTombstonesByTabId = {
          tab: { worktreeId, closedAt: 1 }
        }
      },
      (state, worktreeId) => {
        state.workspaceSession.clientHostedBrowserCloseIntentsByEnvironment = {
          runtime: [{ worktreeId, browserPageId: 'page', closedAt: 1 }]
        }
      },
      (state, worktreeId) => {
        state.workspaceSession.browserPagesByWorkspace = {
          browser: [{ worktreeId } as never]
        }
      },
      (state, worktreeId) => {
        state.workspaceSessionsByHostId = {
          'ssh:builder': {
            ...getDefaultWorkspaceSession(),
            lastVisitedAtByWorktreeId: { [worktreeId]: 1 }
          }
        }
      },
      (state, worktreeId) => {
        state.mobileClientTabSelectionsByDeviceId = {
          phone: { [worktreeId]: {} as never }
        }
      },
      (state, worktreeId) => {
        state.sshRemotePtyLeases = [
          {
            targetId: 'builder',
            ptyId: 'pty',
            worktreeId,
            state: 'detached',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      },
      (state, worktreeId) => {
        state.migrationUnsupportedPtyEntries = [
          {
            ptyId: 'pty',
            worktreeId,
            reason: 'legacy-numeric-pane-key',
            source: 'local',
            updatedAt: 1
          }
        ]
      },
      (state, worktreeId) => {
        state.automations = [
          {
            enabled: true,
            workspaceMode: 'existing',
            workspaceId: worktreeId
          } as never
        ]
      },
      (state, worktreeId) => {
        state.automationRuns = [{ status: 'dispatching', workspaceId: worktreeId } as never]
      }
    ]

    for (const [index, mutate] of ownerMutations.entries()) {
      const state = makeState()
      const worktreeId = `${REPO_ID}::/workspace/owner-${index}`
      state.worktreeMeta[worktreeId] = makeMeta(worktreeId)
      const scan = capture(state)
      mutate(state, worktreeId)
      expect(pruneCaptured(state, scan, [worktreeId])).toEqual([])
    }
  })

  it('preserves canonically equivalent session and top-level owners', () => {
    const candidateId = `${REPO_ID}::/workspace/Café`.normalize('NFC')
    const ownerId = candidateId.normalize('NFD')
    const ownerMutations: ((state: PersistedState) => void)[] = [
      (state) => {
        state.workspaceSession.activeWorktreeId = ownerId
      },
      (state) => {
        state.ui.lastActiveWorktreeId = ownerId
      }
    ]

    for (const mutate of ownerMutations) {
      const state = makeState()
      state.worktreeMeta[candidateId] = makeMeta(candidateId)
      const scan = capture(state)
      mutate(state)

      expect(pruneCaptured(state, scan, [candidateId])).toEqual([])
      expect(state.worktreeMeta[candidateId]).toBeDefined()
    }
  })

  it('removes a row on a later pass after its persisted owner is cleared', () => {
    const state = makeState()
    const worktreeId = `${REPO_ID}::/workspace/two-phase`
    state.worktreeMeta[worktreeId] = makeMeta(worktreeId)
    state.workspaceSession.lastVisitedAtByWorktreeId = { [worktreeId]: 1 }
    const scan = capture(state)

    expect(pruneCaptured(state, scan, [worktreeId])).toEqual([])
    delete state.workspaceSession.lastVisitedAtByWorktreeId![worktreeId]
    expect(pruneCaptured(state, scan, [worktreeId])).toEqual([worktreeId])
  })

  it('treats dotfile visibility and cleanup dismissals as non-owning preferences', () => {
    const state = makeState()
    const worktreeId = `${REPO_ID}::/workspace/non-owning-preferences`
    state.worktreeMeta[worktreeId] = makeMeta(worktreeId)
    const showDotfilesByWorktree = { [worktreeId]: true }
    const workspaceCleanup = {
      dismissals: {
        [worktreeId]: {
          worktreeId,
          dismissedAt: 1,
          fingerprint: 'fingerprint',
          classifierVersion: 1
        }
      }
    }
    state.ui.showDotfilesByWorktree = showDotfilesByWorktree
    state.ui.workspaceCleanup = workspaceCleanup
    const scan = capture(state)

    expect(pruneCaptured(state, scan, [worktreeId])).toEqual([worktreeId])
    expect(state.ui.showDotfilesByWorktree).toBe(showDotfilesByWorktree)
    expect(state.ui.workspaceCleanup).toBe(workspaceCleanup)
  })

  it('preserves foreign aliases, ambiguous local aliases, and divergent projections', () => {
    const foreignState = makeState()
    const foreignId = `${REPO_ID}::/workspace/foreign-alias`
    const localMeta = makeMeta(foreignId)
    const remoteMeta = { ...localMeta, hostId: 'ssh:builder' as const }
    foreignState.worktreeMeta[foreignId] = localMeta
    foreignState.worktreeMetaByIdentity = { local: localMeta, remote: remoteMeta }
    foreignState.worktreeIdentityAliases = {
      [`local|${foreignId}`]: ['local'],
      [`ssh:builder|${foreignId}`]: ['remote']
    }
    const foreignScan = capture(foreignState)

    expect(pruneCaptured(foreignState, foreignScan, [foreignId])).toEqual([])
    expect(foreignState.worktreeMetaByIdentity).toEqual({ local: localMeta, remote: remoteMeta })

    const ambiguousState = makeState()
    const ambiguousId = `${REPO_ID}::/workspace/ambiguous`
    const first = makeMeta(ambiguousId)
    ambiguousState.worktreeMeta[ambiguousId] = first
    ambiguousState.worktreeMetaByIdentity = { first, second: { ...first } }
    ambiguousState.worktreeIdentityAliases = { [`local|${ambiguousId}`]: ['first', 'second'] }
    expect(pruneCaptured(ambiguousState, capture(ambiguousState), [ambiguousId])).toEqual([])

    const divergentState = makeState()
    const divergentId = `${REPO_ID}::/workspace/divergent`
    const legacy = makeMeta(divergentId)
    const canonical = { ...legacy, comment: 'newer canonical comment' }
    divergentState.worktreeMeta[divergentId] = legacy
    divergentState.worktreeMetaByIdentity = { canonical }
    divergentState.worktreeIdentityAliases = { [`local|${divergentId}`]: ['canonical'] }
    const divergentScan = capture(divergentState)
    expect(pruneCaptured(divergentState, divergentScan, [divergentId])).toEqual([])
  })

  it('fails closed for repo replacement, host collisions, remote, runtime, and folder repos', () => {
    const mutations: ((state: PersistedState) => void)[] = [
      (state) => {
        state.repos[0] = makeRepo({ path: '/workspace/replacement' })
      },
      (state) => {
        state.repos.push(makeRepo({ connectionId: 'builder', executionHostId: 'ssh:builder' }))
      },
      (state) => {
        state.repos[0] = makeRepo({ connectionId: 'builder', executionHostId: 'ssh:builder' })
      },
      (state) => {
        state.repos[0] = makeRepo({ executionHostId: 'runtime:environment' })
      },
      (state) => {
        state.repos[0] = makeRepo({ kind: 'folder' })
      }
    ]
    for (const mutate of mutations) {
      const state = makeState()
      const worktreeId = `${REPO_ID}::/workspace/stale`
      state.worktreeMeta[worktreeId] = makeMeta(worktreeId)
      const scan = capture(state)
      mutate(state)
      expect(pruneCaptured(state, scan, [worktreeId])).toEqual([])
    }
  })

  it('fails closed when project runtime routing changes away and back during the scan', () => {
    const state = makeState()
    const worktreeId = `${REPO_ID}::/workspace/project-routing-race`
    const project: Project = {
      id: 'project-1',
      displayName: 'project',
      badgeColor: '#000',
      localWindowsRuntimePreference: { kind: 'windows-host' },
      sourceRepoIds: [REPO_ID],
      createdAt: 1,
      updatedAt: 1
    }
    state.projects = [project]
    state.worktreeMeta[worktreeId] = makeMeta(worktreeId)
    const scan = capture(state)
    project.localWindowsRuntimePreference = { kind: 'wsl', distro: 'Ubuntu' }
    project.updatedAt += 1
    project.localWindowsRuntimePreference = { kind: 'windows-host' }
    project.updatedAt += 1

    expect(pruneCaptured(state, scan, [worktreeId])).toEqual([])
    expect(state.worktreeMeta[worktreeId]).toBeDefined()
  })

  it('fails closed when global runtime routing changes away and back during the scan', () => {
    const state = makeState()
    const worktreeId = `${REPO_ID}::/workspace/settings-routing-race`
    const originalDefault = state.settings.localWindowsRuntimeDefault
    state.worktreeMeta[worktreeId] = makeMeta(worktreeId)
    const scan = capture(state)
    state.settings = {
      ...state.settings,
      localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
    }
    state.settings = {
      ...state.settings,
      localWindowsRuntimeDefault: originalDefault
    }

    expect(state.settings.localWindowsRuntimeDefault).toEqual(originalDefault)
    expect(pruneCaptured(state, scan, [worktreeId])).toEqual([])
    expect(state.worktreeMeta[worktreeId]).toBeDefined()
  })

  it('rejects malformed, folder-instance, WSL, and non-native Windows candidate paths', () => {
    const state = makeState()
    const foreignWindowsId = `${REPO_ID}::C:\\workspace\\stale`
    const ids = [
      `${REPO_ID}::relative/path`,
      `${REPO_ID}::`,
      `wrong::/workspace/stale`,
      `${REPO_ID}::/workspace/folder::workspace:11111111-1111-4111-8111-111111111111`,
      `${REPO_ID}::\\\\wsl.localhost\\Ubuntu\\home\\gone`,
      `${REPO_ID}::/home/user/wsl-legacy`,
      foreignWindowsId
    ]
    for (const worktreeId of ids) {
      state.worktreeMeta[worktreeId] = makeMeta(worktreeId)
    }
    const scan = capture(state)

    expect(pruneCaptured(state, scan, ids.slice(0, -2))).toEqual([])
    expect(pruneCaptured(state, scan, [ids.at(-2)!], 'win32')).toEqual([])
    expect(pruneCaptured(state, scan, [foreignWindowsId], 'linux')).toEqual([])
  })
})
