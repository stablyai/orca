import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  OrcaRecoveryDescriptorV1,
  RecoveryAgentBinding,
  RecoveryLayout,
  RecoveryTab
} from '../../../shared/cross-machine-recovery-descriptor'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { importRecoveryWorkspaceWithHost } from './recovery-import'
import { planRecoveryImport, type RecoveryPlanContext } from './recovery-import-plan'
import { projectRecoveryLayout } from './recovery-layout-projection'
import { descriptor, fixture, SOURCE_GROUP, SOURCE_TAB } from './recovery-import.test-fixture'

const AGENT_TAB = 'structured-agent-session-orca-sess-1'
const AGENT_SESSION_ID = '7b3e3e5f-3333-4444-8555-666677778888'
const SOURCE_WT = 'src-repo::/src/wt'
const OWNED_EDITOR_ID = `editor:${encodeURIComponent(SOURCE_WT)}:local:${encodeURIComponent('/src/wt/a.ts')}`

function agentSessionTab(): RecoveryTab {
  return {
    id: AGENT_TAB,
    entityId: 'orca-sess-1',
    groupId: SOURCE_GROUP,
    contentType: 'agent-session',
    agentSessionAgent: 'claude',
    label: 'Claude chat',
    customLabel: 'planning',
    color: null,
    sortOrder: 2,
    createdAt: 3
  }
}

function structuredBinding(): RecoveryAgentBinding {
  return {
    sourcePaneKey: AGENT_TAB,
    sourceTabId: AGENT_TAB,
    sourceLeafId: null,
    surface: 'structured',
    agent: 'claude',
    providerSession: { key: 'session_id', id: AGENT_SESSION_ID },
    structuredCursor: { provider: 'claude', sessionId: AGENT_SESSION_ID, leafUuid: 'leaf-uuid' },
    liveness: 'sleeping',
    state: 'done',
    launch: { sourceAgentArgs: null, sourceEnvKeys: [] },
    capturedAt: 10,
    updatedAt: 30,
    lastHumanInputAt: null
  }
}

function withActiveAgentSessionTab(d: OrcaRecoveryDescriptorV1): OrcaRecoveryDescriptorV1 {
  const group = d.layout.groups[0]!
  return {
    ...d,
    layout: {
      ...d.layout,
      tabs: [...d.layout.tabs, agentSessionTab()],
      groups: [{ ...group, activeTabId: AGENT_TAB, tabOrder: [...group.tabOrder, AGENT_TAB] }],
      activeTabType: 'agent-session',
      activeTabId: AGENT_TAB
    },
    bindings: [...d.bindings, structuredBinding()]
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
    const d = withActiveAgentSessionTab(descriptor())
    const view = descriptor().layout
    d.presentation = {
      views: [
        {
          clientKey: 'local-renderer',
          clientInstanceId: 'client-1',
          clientName: 'desk',
          clientKind: 'local-renderer',
          hostReceivedAt: 1,
          lastHumanInputAt: 1,
          lastHumanFocusAt: 1,
          focus: {
            isActiveWorkspace: true,
            focusedTabId: SOURCE_TAB,
            focusedLeafId: null,
            focusedPaneKey: null,
            windowFocused: true
          },
          view
        }
      ],
      preferredClientKey: 'local-renderer',
      freshness: 'client-view'
    }

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
    const d = withActiveAgentSessionTab(descriptor())
    const emptyView: RecoveryLayout = {
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
    d.presentation = {
      views: [
        {
          clientKey: 'local-renderer',
          clientInstanceId: 'client-1',
          clientName: 'desk',
          clientKind: 'local-renderer',
          hostReceivedAt: 1,
          lastHumanInputAt: 1,
          lastHumanFocusAt: 1,
          focus: {
            isActiveWorkspace: true,
            focusedTabId: null,
            focusedLeafId: null,
            focusedPaneKey: null,
            windowFocused: true
          },
          view: emptyView
        }
      ],
      preferredClientKey: 'local-renderer',
      freshness: 'client-view'
    }

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
