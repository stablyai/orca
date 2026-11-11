import { useEffect } from 'react'
import { stripLeadingAgentTitleDecoration } from '../../../shared/agent-status/title/agent-title-decoration'
import { resolveUnifiedTabLabel } from '../../../shared/tab-title-resolution'
import { branchName } from '../lib/source-control/branches/branch-name'
import { DEFAULT_WINDOW_TITLE_TEMPLATE, renderWindowTitle } from '../lib/window-title-template'
import { resolveLinkedTaskIdentifier } from '../lib/workspace/search/worktrees/worktree-palette-evidence'
import { useStructuredChatTabNames } from '../runtime/native-chat/naming/structured-chat-name-observation'
import {
  projectedStructuredChatTabName,
  type StructuredChatTabNames
} from '../runtime/native-chat/naming/structured-chat-tab-name'
import { useAppStore } from '../store'
import type { AppState } from '../store/types'
import { selectRepoByIdForActiveWorkspace } from '../store/repos/active-workspace-repository'

/** Names the active tab like the tab bar does: terminal-owned titles fill gaps in the unified tab. */
function selectActiveTabLabel(
  s: AppState,
  worktreeId: string,
  chatNames: StructuredChatTabNames
): string | null {
  const tab = s.getActiveTab(worktreeId)
  if (!tab) {
    return null
  }
  if (tab.contentType === 'agent-session') {
    return projectedStructuredChatTabName(tab, chatNames) || null
  }
  const enabled = s.settings?.tabAutoGenerateTitle === true
  const terminal =
    tab.contentType === 'terminal'
      ? (s.tabsByWorktree[worktreeId] ?? []).find((t) => t.id === tab.entityId)
      : undefined
  const generated = (tab.generatedLabel ?? terminal?.generatedTitle)?.trim()
  const session = resolveUnifiedTabLabel(
    terminal
      ? {
          ...tab,
          customLabel: tab.customLabel ?? terminal.customTitle ?? null,
          quickCommandLabel: tab.quickCommandLabel ?? terminal.quickCommandLabel,
          generatedLabel: generated,
          label: tab.label || terminal.title
        }
      : tab,
    enabled
  )
  // Agent status glyphs change every turn; a time tracker would log one task as several.
  const name = session ? stripLeadingAgentTitleDecoration(session) : ''
  const task = enabled && generated && generated !== name ? generated : ''
  return [name, task].filter(Boolean).join(' · ') || null
}

// Keeps each surface's own idle title (e.g. "Orca Web").
const idleTitle = typeof document === 'undefined' ? 'Orca' : document.title

if (import.meta !== undefined && import.meta.hot) {
  // HMR re-reads document.title above, so hand it back idle instead of a workspace title.
  import.meta.hot.dispose(() => {
    document.title = idleTitle
  })
}

/** Renders the title template for the active workspace; null while the setting is off or nothing is active. */
function selectWindowTitle(s: AppState, chatNames: StructuredChatTabNames): string | null {
  const worktree = s.activeWorktreeId
    ? s.getKnownWorktreeById(s.activeWorktreeId, s.activeWorkspaceExecutionHostId ?? undefined)
    : null
  if (!worktree || s.settings?.showWorkspaceInWindowTitle !== true) {
    return null
  }
  const template = s.settings?.windowTitle?.trim() || DEFAULT_WINDOW_TITLE_TEMPLATE
  const repoName = selectRepoByIdForActiveWorkspace(s, worktree.repoId)?.displayName ?? null
  return renderWindowTitle(template, {
    appName: idleTitle,
    // A folder workspace named like its project would otherwise repeat the name.
    repo: repoName === worktree.displayName ? null : repoName,
    worktree: worktree.displayName,
    branch: worktree.branch ? branchName(worktree.branch) : null,
    issueKey: resolveLinkedTaskIdentifier(worktree),
    tab: template.includes('${tab}') ? selectActiveTabLabel(s, worktree.id, chatNames) : null
  })
}

/** The title the window shows now, falling back to the surface's idle title. */
export function useResolvedWindowTitle(): string {
  // Chat names live outside the store; subscribing here re-runs the selector when one changes.
  const chatNames = useStructuredChatTabNames()
  return useAppStore((s) => selectWindowTitle(s, chatNames)) || idleTitle
}

/** Time trackers read the native title, which Electron mirrors from document.title. */
export function useWindowTitle(): void {
  const title = useResolvedWindowTitle()
  useEffect(() => {
    document.title = title
  }, [title])
}
