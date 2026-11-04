import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'
import type { WorkspaceSurface } from '../../shared/workspace-surfaces/surface-content'
import { projectSurfaceSession } from '../../shared/workspace-surfaces/surface-session-projection'
import { seedWorkspaceSurfaces } from './surface-migration'
import { emptySurfaceHostDomain } from '../../shared/workspace-surfaces/surface-profile-domain'
import { nameBasedUuid } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import { workspaceSurfaceSchema } from '../../shared/workspace-surfaces/surface-schema'
import { reserveImportedSurfaceIdentities } from './surface-migration-identities'

const leafId = '339343d0-9fcb-4d4d-8bf6-69615be0f927'
const snapshot: WorkspaceSessionState = {
  activeRepoId: null,
  activeWorktreeId: 'folder',
  activeTabId: 'container',
  tabsByWorktree: {
    folder: [
      {
        id: 'terminal',
        ptyId: 'process',
        worktreeId: 'folder',
        title: 'Shell',
        customTitle: 'Work',
        color: 'blue',
        isPinned: true,
        createdAt: 1,
        sortOrder: 0
      }
    ]
  },
  terminalLayoutsByTabId: {
    terminal: {
      root: { type: 'leaf', leafId },
      activeLeafId: leafId,
      expandedLeafId: null,
      ptyIdsByLeafId: { [leafId]: 'process' }
    }
  },
  terminalPtyIncarnationsByPaneKey: { [`terminal:${leafId}`]: 'incarnation' },
  unifiedTabs: {
    folder: [
      {
        id: 'container',
        entityId: 'terminal',
        contentType: 'terminal',
        executionHostId: 'local',
        worktreeId: 'folder',
        label: 'Shell',
        customLabel: 'Work',
        color: 'blue',
        isPinned: true,
        groupId: 'group',
        sortOrder: 0,
        createdAt: 1
      },
      {
        id: 'editor',
        entityId: '/file.md',
        contentType: 'editor',
        executionHostId: 'local',
        worktreeId: 'folder',
        label: 'file.md',
        customLabel: null,
        color: null,
        groupId: 'group',
        sortOrder: 1,
        createdAt: 2
      },
      {
        id: 'browser',
        entityId: 'browser-record',
        contentType: 'browser',
        executionHostId: 'local',
        worktreeId: 'folder',
        label: 'Browser',
        customLabel: null,
        color: null,
        groupId: 'group',
        sortOrder: 2,
        createdAt: 3
      }
    ]
  },
  tabGroups: {
    folder: [
      {
        id: 'group',
        worktreeId: 'folder',
        activeTabId: 'container',
        tabOrder: ['browser', 'container', 'editor']
      }
    ]
  },
  openFilesByWorktree: {
    folder: [
      {
        filePath: '/file.md',
        relativePath: 'file.md',
        worktreeId: 'folder',
        language: 'markdown',
        dirtyDraftContent: 'unsaved'
      }
    ]
  },
  browserTabsByWorktree: {
    folder: [
      {
        id: 'browser-record',
        worktreeId: 'folder',
        label: 'Browser',
        url: 'https://example.com',
        title: 'Example',
        faviconUrl: null,
        loading: false,
        loadError: null,
        canGoBack: false,
        canGoForward: false,
        sessionProfileId: null,
        sessionPartition: null,
        pageIds: [],
        createdAt: 3
      }
    ]
  }
}

describe('canonical surface migration and presentation projection', () => {
  it('retains rejected resource claims when old rows repeat entity and pane identities across workspaces', () => {
    const session = structuredClone(snapshot)
    session.tabsByWorktree.other = [
      { ...session.tabsByWorktree.folder![0]!, worktreeId: 'other', ptyId: 'other-process' }
    ]
    session.unifiedTabs!.other = [{ ...session.unifiedTabs!.folder![0]!, worktreeId: 'other' }]
    const evidence = emptySurfaceHostDomain()
    let sequence = 0
    const surfaces = seedWorkspaceSurfaces(
      'local',
      session,
      [],
      () => nameBasedUuid(`collision:${++sequence}`),
      evidence
    )
    expect(surfaces).toHaveLength(2)
    expect(new Set(surfaces.map((surface) => surface.hostTabId)).size).toBe(2)
    expect(evidence.identityMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'host-tab', previousId: 'container' }),
        expect.objectContaining({ kind: 'terminal-entity', previousId: 'terminal' })
      ])
    )
    expect(evidence.retainedReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'terminal',
          workspaceId: 'other',
          raw: expect.objectContaining({ ptyId: 'other-process' })
        })
      ])
    )
    expect(
      surfaces.flatMap((surface) =>
        surface.content?.kind === 'terminal'
          ? Object.values(surface.content.leaves).map((leaf) => leaf.facts.ptyId)
          : []
      )
    ).toEqual(expect.arrayContaining(['process', 'other-process']))
    surfaces.forEach((surface) => workspaceSurfaceSchema.parse(surface))
    const retained = structuredClone(evidence)
    const reopened = seedWorkspaceSurfaces(
      'local',
      session,
      [],
      () => nameBasedUuid(`collision:${++sequence}`),
      evidence
    )
    expect(reopened.map((surface) => [surface.hostTabId, surface.content])).toMatchObject(
      surfaces.map((surface) => [
        surface.hostTabId,
        surface.content?.kind === 'terminal'
          ? { entityId: surface.content.entityId, root: surface.content.root }
          : surface.content
      ])
    )
    expect(evidence).toEqual(retained)
  })

  it('keeps distinct processes on remapped repeated leaves and retains unplaced layouts', () => {
    const session = structuredClone(snapshot)
    session.tabsByWorktree.folder!.push({
      ...session.tabsByWorktree.folder![0]!,
      id: 'second',
      ptyId: 'second-process'
    })
    session.unifiedTabs!.folder!.push({
      ...session.unifiedTabs!.folder![0]!,
      id: 'second-container',
      entityId: 'second'
    })
    session.terminalLayoutsByTabId.second = {
      ...session.terminalLayoutsByTabId.terminal!,
      ptyIdsByLeafId: { [leafId]: 'second-process' }
    }
    session.terminalPtyIncarnationsByPaneKey![`second:${leafId}`] = 'second-incarnation'
    session.terminalLayoutsByTabId.unplaced = {
      ...session.terminalLayoutsByTabId.terminal!,
      ptyIdsByLeafId: { [leafId]: 'unplaced-process' }
    }
    const evidence = emptySurfaceHostDomain()
    let sequence = 0
    const surfaces = seedWorkspaceSurfaces(
      'local',
      session,
      [],
      () => nameBasedUuid(`leaf-collision:${++sequence}`),
      evidence
    )
    const resources = surfaces.flatMap((surface) =>
      surface.content?.kind === 'terminal'
        ? Object.values(surface.content.leaves).map((leaf) => leaf.facts.ptyId)
        : []
    )
    expect(resources).toEqual(expect.arrayContaining(['process', 'second-process']))
    expect(evidence.identityMappings).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'leaf', previousId: leafId })])
    )
    expect(evidence.retainedReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'terminal-layout',
          id: 'unplaced',
          raw: session.terminalLayoutsByTabId.unplaced
        })
      ])
    )
    surfaces.forEach((surface) => workspaceSurfaceSchema.parse(surface))
  })

  it('retains unverified native references while terminal membership is already authoritative', () => {
    const session = structuredClone(snapshot)
    session.unifiedTabs!.folder!.push({
      id: 'unknown-chat',
      entityId: 'conversation',
      contentType: 'agent-session',
      agentSessionAgent: 'codex',
      executionHostId: 'local',
      worktreeId: 'folder',
      label: 'Chat',
      customLabel: null,
      color: null,
      groupId: 'group',
      sortOrder: 3,
      createdAt: 4
    })
    const terminals = seedWorkspaceSurfaces('local', snapshot, [])
    expect(projectSurfaceSession('local', session, terminals, false).unifiedTabs?.folder).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'unknown-chat', entityId: 'conversation' })
      ])
    )
    expect(
      projectSurfaceSession('local', session, terminals, true).unifiedTabs?.folder?.some(
        (tab) => tab.id === 'unknown-chat'
      )
    ).toBe(false)
  })
  it('preserves terminal resources when a legacy native chat claims the same container id', () => {
    let sequence = 0
    const seeds = seedWorkspaceSurfaces(
      'local',
      snapshot,
      [
        {
          workspaceId: 'folder',
          tabId: 'container',
          sessionId: 'conversation',
          agent: 'codex',
          createdAt: 2
        }
      ],
      () => `migration-${++sequence}`
    )
    expect(seeds).toHaveLength(2)
    const terminal = seeds.find((surface) => surface.content?.kind === 'terminal')!
    const chat = seeds.find((surface) => surface.content?.kind === 'agent-session')!
    expect(terminal.hostTabId).toBe('container')
    expect(chat.hostTabId).not.toBe(terminal.hostTabId)
    expect(terminal.content).toMatchObject({
      leaves: {
        [leafId]: {
          facts: { ptyId: 'process', incarnationId: 'incarnation' }
        }
      }
    })
    expect(chat.content).toEqual({
      kind: 'agent-session',
      sessionId: 'conversation',
      agent: 'codex'
    })
  })

  it('uses canonical content despite a stale save while retaining pin, placement and other tab kinds', () => {
    const surface: WorkspaceSurface = {
      hostId: 'local',
      workspaceId: 'folder',
      hostTabId: 'container',
      occurrence: 'new-content',
      revision: 2,
      createdAt: 1,
      content: { kind: 'agent-session', sessionId: 'conversation', agent: 'codex' }
    }
    const before = structuredClone(snapshot)
    const projected = projectSurfaceSession('local', snapshot, [surface])
    expect(projected.unifiedTabs?.folder?.find((tab) => tab.id === 'container')).toMatchObject({
      entityId: 'conversation',
      contentType: 'agent-session',
      isPinned: true,
      customLabel: 'Work',
      color: 'blue',
      groupId: 'group',
      sortOrder: 1
    })
    expect(projected.tabGroups?.folder?.[0]?.tabOrder).toEqual(['browser', 'container', 'editor'])
    expect(projected.tabsByWorktree.folder).toEqual([])
    expect(projected.terminalLayoutsByTabId.terminal).toBeUndefined()
    expect(projected.terminalPtyIncarnationsByPaneKey).toBeUndefined()
    expect(projected.openFilesByWorktree).toEqual(snapshot.openFilesByWorktree)
    expect(projected.browserTabsByWorktree).toEqual(snapshot.browserTabsByWorktree)
    expect(projected.unifiedTabs?.folder?.filter((tab) => tab.id !== 'container')).toEqual(
      expect.arrayContaining(
        snapshot.unifiedTabs?.folder
          ?.filter((tab) => tab.id !== 'container')
          .map((tab) => ({ ...tab, sortOrder: tab.id === 'browser' ? 0 : 2 })) ?? []
      )
    )
    expect(snapshot).toEqual(before)
    expect(projectSurfaceSession('local', snapshot, []).unifiedTabs?.folder).toHaveLength(2)
  })
})

it('indexes migration mapping history once per import batch and reuses the exact elected identities at N and 10N', () => {
  const counts = [20, 200].map((count) => {
    let visits = 0
    const evidence = emptySurfaceHostDomain()
    evidence.identityMappings = Array.from({ length: count }, (_, index) => ({
      workspaceId: 'folder',
      kind: 'host-tab' as const,
      get previousId() {
        visits++
        return `historical-${index}`
      },
      currentId: `historical-current-${index}`
    }))
    const incoming: WorkspaceSurface[] = Array.from({ length: count }, (_, index) => ({
      hostId: 'local',
      workspaceId: 'folder',
      hostTabId: `tab-${index}`,
      occurrence: `occurrence-${index}`,
      revision: 1,
      createdAt: 1,
      content: { kind: 'agent-session', sessionId: `conversation-${index}`, agent: 'codex' }
    }))
    const reserved = incoming.map((surface) => surface.hostTabId)
    let minted = 0
    const first = reserveImportedSurfaceIdentities(
      incoming,
      [],
      reserved,
      evidence,
      () => `new-${++minted}`
    )
    const firstVisits = visits
    const mappingCount = evidence.identityMappings.length
    visits = 0
    const replay = reserveImportedSurfaceIdentities(
      incoming,
      [],
      reserved,
      evidence,
      () => `new-${++minted}`
    )
    expect(replay).toEqual(first)
    expect(evidence.identityMappings).toHaveLength(mappingCount)
    expect(first.every((surface, index) => surface.hostTabId !== incoming[index]!.hostTabId)).toBe(
      true
    )
    expect(firstVisits).toBeGreaterThan(0)
    expect(firstVisits).toBeLessThanOrEqual(2 * count)
    expect(visits).toBeLessThanOrEqual(2 * count)
    return firstVisits
  })
  expect(counts[1]).toBeLessThanOrEqual(counts[0]! * 10)
})
