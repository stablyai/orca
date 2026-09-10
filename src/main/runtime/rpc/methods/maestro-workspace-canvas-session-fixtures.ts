import { MaestroBrowserSurfaceReceiptSchema } from '../../../../shared/maestro-browser-surface'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'

export const scope = { execution_host_id: 'local', workspace_key: 'folder:folder-1' }

export function session(snapshotVersion = 1): RuntimeMobileSessionTabsResult {
  return {
    worktree: 'folder-1',
    publicationEpoch: 'renderer-1',
    snapshotVersion,
    activeGroupId: 'group-1',
    activeTabId: 'terminal-tab-1',
    activeTabType: 'terminal',
    tabGroups: [
      {
        id: 'group-1',
        activeTabId: 'terminal-tab-1',
        tabOrder: ['terminal-tab-1', 'browser-tab-1']
      }
    ],
    tabs: [
      {
        type: 'terminal',
        id: 'terminal-tab-1::leaf-1',
        parentTabId: 'terminal-tab-1',
        leafId: 'leaf-1',
        ptyId: 'pty-1',
        status: 'ready',
        terminal: 'terminal-handle-1',
        title: 'Shell',
        isActive: true
      },
      {
        type: 'browser',
        id: 'browser-tab-1',
        title: 'Docs',
        browserWorkspaceId: 'browser-workspace-1',
        browserPageId: 'browser-page-1',
        url: 'https://example.com',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        isActive: false
      }
    ]
  }
}

export function editorSession(isDirty: boolean): RuntimeMobileSessionTabsResult {
  return {
    ...session(),
    snapshotVersion: isDirty ? 2 : 1,
    activeTabId: 'editor-tab-1',
    activeTabType: 'file',
    tabGroups: [{ id: 'group-1', activeTabId: 'editor-tab-1', tabOrder: ['editor-tab-1'] }],
    tabs: [
      {
        type: 'file',
        id: 'editor-tab-1',
        title: 'app.ts',
        filePath: '/workspace/app.ts',
        relativePath: 'app.ts',
        language: 'typescript',
        mode: 'edit',
        isDirty,
        isActive: true
      }
    ]
  }
}

export function linkedSession(): RuntimeMobileSessionTabsResult {
  return {
    ...session(),
    tabGroups: [
      {
        id: 'group-1',
        activeTabId: 'terminal-tab-1',
        tabOrder: ['terminal-tab-1', 'browser-tab-1', 'editor-tab-1', 'notes-tab-1']
      }
    ],
    tabs: [
      ...session().tabs,
      {
        type: 'file',
        id: 'editor-tab-1',
        title: 'app.ts',
        filePath: '/workspace/app.ts',
        relativePath: 'app.ts',
        language: 'typescript',
        mode: 'edit',
        isDirty: false,
        isActive: false
      },
      {
        type: 'markdown',
        id: 'notes-tab-1',
        title: 'Notes',
        filePath: '/workspace/notes.md',
        relativePath: 'notes.md',
        language: 'markdown',
        mode: 'edit',
        isDirty: false,
        isActive: false,
        sourceFileId: '/workspace/notes.md',
        sourceFilePath: '/workspace/notes.md',
        sourceRelativePath: 'notes.md',
        documentVersion: 'notes-1'
      }
    ]
  }
}

export function parentChildSession(): RuntimeMobileSessionTabsResult {
  const current = session()
  return {
    ...current,
    tabGroups: [
      {
        id: 'group-1',
        activeTabId: 'terminal-tab-1',
        tabOrder: ['terminal-tab-1', 'terminal-tab-parent']
      }
    ],
    tabs: [
      current.tabs[0]!,
      {
        type: 'terminal',
        id: 'terminal-tab-parent::leaf-parent',
        parentTabId: 'terminal-tab-parent',
        leafId: 'leaf-parent',
        ptyId: 'pty-parent',
        status: 'ready',
        terminal: 'terminal-handle-parent',
        title: 'Parent worker',
        isActive: false
      }
    ]
  }
}

export function browserReceipt(
  overrides: {
    workspaceKey?: string
    runId?: string
    taskId?: string
    attemptId?: string
    agentId?: string
  } = {}
) {
  return MaestroBrowserSurfaceReceiptSchema.parse({
    schema_version: 1,
    protocol: 'maestro-browser-surface/v1',
    surface_id: 'browser-surface-1',
    request_id: 'browser-request-1',
    run_id: overrides.runId ?? 'run-1',
    task_id: overrides.taskId ?? 'MWC-INTEG',
    attempt_id: overrides.attemptId ?? 'attempt-mwc-integ-002',
    agent_id: overrides.agentId ?? 'codex',
    owner_principal: 'coordinator-generation-2',
    ownership: 'harness',
    execution_host_id: scope.execution_host_id,
    workspace_key: overrides.workspaceKey ?? scope.workspace_key,
    browser_page_id: 'browser-page-1',
    title: 'Docs',
    url: 'https://example.com/',
    origin: 'https://example.com',
    profile_id: null,
    requested_visibility: 'visible',
    observed_visibility: 'visible',
    viewport: { width: 1280, height: 720, device_scale_factor: 1 },
    retention: 'retain',
    state: 'active',
    focus_receipt: {
      requested: true,
      workspace_activated: true,
      exact_page_selected: true,
      native_pane_paint: 'painted',
      observed_at: '2026-08-25T20:00:00.000Z',
      unavailable_reason: null
    },
    evidence: {
      route_or_component: 'Maestro workspace Canvas',
      state: 'exact Browser surface',
      theme: 'light',
      source_revision: 'browser-1',
      capture_mode: 'native-viewport'
    },
    evidence_receipt: null,
    release_receipt: {
      requested: false,
      outcome: 'not_requested',
      exact_page_closed: false,
      profile_affected: false,
      observed_at: null,
      reason: null
    },
    created_at: '2026-08-25T20:00:00.000Z',
    updated_at: '2026-08-25T20:00:00.000Z'
  })
}
