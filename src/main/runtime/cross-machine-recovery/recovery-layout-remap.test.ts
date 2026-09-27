import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RecoveryLayout } from '../../../shared/cross-machine-recovery-descriptor'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { importRecoveryWorkspaceWithHost } from './recovery-import'
import { planRecoveryImport, type RecoveryPlanContext } from './recovery-import-plan'
import { projectRecoveryLayout } from './recovery-layout-projection'
import {
  AGENT_SESSION_ID,
  AGENT_TAB,
  descriptor,
  fixture,
  SOURCE_GROUP,
  SOURCE_LEAF,
  SOURCE_TAB,
  withActiveAgentSessionTab,
  withPreferredClientView
} from './recovery-import.test-fixture'

const SOURCE_WT = 'src-repo::/src/wt'
const OWNED_EDITOR_ID = `editor:${encodeURIComponent(SOURCE_WT)}:local:${encodeURIComponent('/src/wt/a.ts')}`

function emptyView(): RecoveryLayout {
  return {
    tabs: [],
    groups: [],
    groupLayout: null,
    activeGroupId: null,
    terminalTabs: [],
    terminalLayouts: {},
    startupCwdRelative: {},
    editors: [],
    activeEditorRelativePath: null,
    browsers: [],
    activeBrowserId: null,
    activeTabType: null,
    activeTabId: null
  }
}

function planContext(checkoutPath: string): RecoveryPlanContext {
  return {
    worktreeId: `repo-1::${checkoutPath}`,
    checkoutPath,
    sourceWorkspacePath: '/src/wt',
    now: 1_000,
    mintId: () => randomUUID(),
    importKey: 'import-key',
    pathMap: [],
    sourceProviderSessionIds: new Map()
  }
}

describe('structured session placeholders', () => {
  it('imports a dormant structured session into a visible terminal pane in its source slot', async () => {
    const f = fixture()
    const d = withActiveAgentSessionTab(descriptor())

    const result = await importRecoveryWorkspaceWithHost(
      f.host,
      { descriptor: d, checkoutPath: f.checkout, checkpointId: 'cp' },
      f.readCommonDir
    )

    const session = f.getSession()
    const record = Object.values(session.sleepingAgentSessionsByPaneKey ?? {}).find(
      (candidate) => candidate.providerSession.id === AGENT_SESSION_ID
    )!
    const pane = parsePaneKey(record.paneKey)!
    const placeholder = session.tabsByWorktree[f.worktreeId]!.find((tab) => tab.id === pane.tabId)
    expect(placeholder).toMatchObject({ id: pane.tabId, ptyId: null, customTitle: 'planning' })
    expect(placeholder?.launchAgent).toBeUndefined()
    expect(session.terminalLayoutsByTabId[pane.tabId]).toEqual({
      root: { type: 'leaf', leafId: pane.leafId },
      activeLeafId: pane.leafId,
      expandedLeafId: null
    })
    const localGroup = result.idMap.groups[SOURCE_GROUP]!
    expect(session.unifiedTabs?.[f.worktreeId]?.find((tab) => tab.id === pane.tabId)).toMatchObject(
      { entityId: pane.tabId, contentType: 'terminal', groupId: localGroup, sortOrder: 2 }
    )
    const group = session.tabGroups?.[f.worktreeId]?.find(
      (candidate) => candidate.id === localGroup
    )
    expect(group?.tabOrder).toEqual([
      result.idMap.tabs[SOURCE_TAB],
      path.join(f.checkout, 'a.ts'),
      pane.tabId
    ])
    expect(group?.activeTabId).toBe(pane.tabId)
    expect(session.activeTabTypeByWorktree?.[f.worktreeId]).toBe('terminal')
    expect(session.activeTabIdByWorktree?.[f.worktreeId]).toBe(pane.tabId)
    expect(result.bindings.find((b) => b.binding.id === AGENT_SESSION_ID)).toMatchObject({
      status: 'dormant',
      localPaneKey: record.paneKey
    })
  })

  it('keeps the host placeholder when the chosen client view lacks the agent-session tab', () => {
    const d = withPreferredClientView(withActiveAgentSessionTab(descriptor()), descriptor().layout)

    const plan = planRecoveryImport(d, undefined, planContext('/dst/wt'))

    const planned = plan.bindings.find((b) => b.binding.surface === 'structured')!
    const pane = parsePaneKey(planned.result.localPaneKey)!
    expect(plan.presentationSource).toEqual({ kind: 'client-view', clientKey: 'local-renderer' })
    expect(plan.fragment.terminalTabs.map((tab) => tab.id)).toContain(pane.tabId)
    expect(plan.fragment.terminalLayoutsByTabId[pane.tabId]?.root).toEqual({
      type: 'leaf',
      leafId: pane.leafId
    })
    expect(plan.fragment.tabGroups[0]?.tabOrder).toContain(pane.tabId)
  })

  it('gives every host binding a visible tab when the chosen client view has no groups', () => {
    const d = withPreferredClientView(withActiveAgentSessionTab(descriptor()), emptyView())

    const plan = planRecoveryImport(d, undefined, planContext('/dst/wt'))

    expect(plan.presentationSource).toEqual({ kind: 'client-view', clientKey: 'local-renderer' })
    const group = plan.fragment.tabGroups[0]!
    expect(plan.fragment.tabGroups).toHaveLength(1)
    expect(plan.fragment.tabGroupLayout).toEqual({ type: 'leaf', groupId: group.id })
    expect(plan.fragment.activeGroupId).toBe(group.id)
    const paneTabIds = plan.bindings.map((planned) => {
      const pane = parsePaneKey(planned.result.localPaneKey)!
      expect(plan.fragment.terminalLayoutsByTabId[pane.tabId]?.root).toEqual({
        type: 'leaf',
        leafId: pane.leafId
      })
      return pane.tabId
    })
    expect(plan.fragment.unifiedTabs.map((tab) => [tab.id, tab.entityId, tab.groupId])).toEqual(
      paneTabIds.map((tabId) => [tabId, tabId, group.id])
    )
    expect(group.tabOrder).toEqual(paneTabIds)
    expect(group.activeTabId).toBe(plan.idMap.tabs[AGENT_TAB])
  })

  it('places a host binding whose terminal row the groupless client view kept', () => {
    const host = descriptor().layout
    const view: RecoveryLayout = {
      ...emptyView(),
      terminalTabs: host.terminalTabs,
      terminalLayouts: host.terminalLayouts
    }
    const d = withPreferredClientView(withActiveAgentSessionTab(descriptor()), view)

    const plan = planRecoveryImport(d, undefined, planContext('/dst/wt'))

    expect(plan.presentationSource).toEqual({ kind: 'client-view', clientKey: 'local-renderer' })
    const localGroup = plan.idMap.groups[SOURCE_GROUP]!
    expect(plan.fragment.tabGroups.map((group) => group.id)).toEqual([localGroup])
    expect(plan.fragment.tabGroupLayout).toEqual({ type: 'leaf', groupId: localGroup })
    const panes = plan.bindings.map((planned) => parsePaneKey(planned.result.localPaneKey)!)
    expect(panes.map((pane) => pane.tabId)).toEqual([
      plan.idMap.tabs[SOURCE_TAB],
      plan.idMap.tabs[AGENT_TAB]
    ])
    expect(panes[0]?.leafId).toBe(plan.idMap.leaves[SOURCE_LEAF])
    expect(plan.fragment.terminalTabs.map((tab) => tab.id)).toEqual(panes.map((pane) => pane.tabId))
    expect(plan.fragment.unifiedTabs.map((tab) => [tab.entityId, tab.groupId])).toEqual(
      panes.map((pane) => [pane.tabId, localGroup])
    )
    expect(plan.fragment.tabGroups[0]?.tabOrder).toEqual(panes.map((pane) => pane.tabId))
  })

  it('synthesizes a tab and group for a host binding the host layout never placed', () => {
    const d = descriptor()
    const grouplessHost = {
      ...d,
      layout: { ...d.layout, tabs: [], groups: [], groupLayout: null, activeGroupId: null }
    }
    const ctx = planContext('/dst/wt')

    const plan = planRecoveryImport(grouplessHost, undefined, ctx)

    expect(plan.presentationSource).toEqual({ kind: 'host-layout' })
    const pane = parsePaneKey(plan.bindings[0]!.result.localPaneKey)!
    expect([pane.tabId, pane.leafId]).toEqual([
      plan.idMap.tabs[SOURCE_TAB],
      plan.idMap.leaves[SOURCE_LEAF]
    ])
    const groupId = plan.fragment.activeGroupId!
    expect(plan.fragment.tabGroups).toEqual([
      { id: groupId, worktreeId: ctx.worktreeId, activeTabId: pane.tabId, tabOrder: [pane.tabId] }
    ])
    expect(plan.fragment.tabGroupLayout).toEqual({ type: 'leaf', groupId })
    expect(plan.fragment.unifiedTabs).toEqual([
      {
        id: pane.tabId,
        entityId: pane.tabId,
        groupId,
        worktreeId: ctx.worktreeId,
        contentType: 'terminal',
        label: 'claude',
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ])
  })
})

describe('workspace-scoped editor ids', () => {
  function editorSession(): WorkspaceSessionState {
    return {
      activeRepoId: null,
      activeWorktreeId: SOURCE_WT,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        [SOURCE_WT]: [
          {
            filePath: '/src/wt/a.ts',
            relativePath: 'a.ts',
            worktreeId: SOURCE_WT,
            language: 'typescript'
          }
        ]
      },
      activeFileIdByWorktree: { [SOURCE_WT]: OWNED_EDITOR_ID },
      unifiedTabs: {
        [SOURCE_WT]: [
          {
            id: OWNED_EDITOR_ID,
            entityId: OWNED_EDITOR_ID,
            groupId: SOURCE_GROUP,
            worktreeId: SOURCE_WT,
            contentType: 'editor',
            label: 'a.ts',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        [SOURCE_WT]: [
          {
            id: SOURCE_GROUP,
            worktreeId: SOURCE_WT,
            activeTabId: OWNED_EDITOR_ID,
            tabOrder: [OWNED_EDITOR_ID],
            recentTabIds: [OWNED_EDITOR_ID]
          }
        ]
      },
      tabGroupLayouts: { [SOURCE_WT]: { type: 'leaf', groupId: SOURCE_GROUP } },
      activeGroupIdByWorktree: { [SOURCE_WT]: SOURCE_GROUP },
      activeTabTypeByWorktree: { [SOURCE_WT]: 'editor' },
      activeTabIdByWorktree: { [SOURCE_WT]: OWNED_EDITOR_ID }
    }
  }

  it('exports the backing file of an active editor with a workspace-scoped id', () => {
    const layout = projectRecoveryLayout(editorSession(), SOURCE_WT, '/src/wt')

    expect(layout.activeEditorRelativePath).toBe('a.ts')
    expect(layout.tabs[0]?.entityId).toBe('/src/wt/a.ts')
  })

  it('round-trips the editor tab, its group slot and the active selection', () => {
    const d = descriptor()
    d.layout = projectRecoveryLayout(editorSession(), SOURCE_WT, '/src/wt')
    d.bindings = []

    const plan = planRecoveryImport(d, undefined, planContext('/dst/wt'))

    const localPath = path.join('/dst/wt', 'a.ts')
    expect(plan.fragment.openFiles.map((file) => file.filePath)).toEqual([localPath])
    expect(plan.fragment.unifiedTabs).toEqual([
      expect.objectContaining({ id: localPath, entityId: localPath, contentType: 'editor' })
    ])
    expect(plan.fragment.tabGroups[0]).toMatchObject({
      activeTabId: localPath,
      tabOrder: [localPath],
      recentTabIds: [localPath]
    })
    expect(plan.fragment.activeFileId).toBe(localPath)
    expect(plan.fragment.activeTabType).toBe('editor')
    expect(plan.fragment.activeTabId).toBe(localPath)
  })
})
