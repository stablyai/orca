import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// RATCHET — this list may only SHRINK. Each entry still imports the frozen dark `colors`
// alias and therefore will not follow the app theme. Delete entries as you convert;
// never add one. Empty list == migration complete.
const UNTHEMED_COLOR_IMPORTERS: readonly string[] = [
  'src/components/CodexResetCreditAction.tsx',
  'app/_layout.tsx',
  'app/about.tsx',
  'app/browser-settings.tsx',
  'app/connection-log.tsx',
  'app/h/[hostId]/accounts-screen-styles.ts',
  'app/h/[hostId]/accounts.tsx',
  'app/h/[hostId]/edit.tsx',
  'app/h/[hostId]/index.tsx',
  'app/h/[hostId]/session/QuickCommandsTabButton.tsx',
  'app/h/[hostId]/session/[worktreeId].tsx',
  'app/h/[hostId]/session/mobile-session-command-input-styles.ts',
  'app/h/[hostId]/session/mobile-session-frame-styles.ts',
  'app/h/[hostId]/session/mobile-session-reader-styles.ts',
  'app/h/[hostId]/session/mobile-session-review-comment-styles.ts',
  'app/h/[hostId]/tasks.tsx',
  'app/h/_layout.tsx',
  'app/index.tsx',
  'app/native-chat-settings.tsx',
  'app/notifications.tsx',
  'app/pair-confirm.tsx',
  'app/pair-scan.tsx',
  'app/pair.tsx',
  'app/settings.tsx',
  'app/terminal-settings.tsx',
  'app/troubleshoot.tsx',
  'app/voice-settings.tsx',
  'src/agent-history/MobileAgentSessionHistoryList.tsx',
  'src/agent-history/MobileAgentSessionHistoryPanel.tsx',
  'src/agent-history/agent-history-styles.ts',
  'src/agent-history/worktree-navigation-actions.ts',
  'src/browser/MobileBrowserKeyRow.tsx',
  'src/browser/MobileBrowserPane.tsx',
  'src/browser/MobileBrowserPointerModifiers.tsx',
  'src/browser/MobileBrowserToolbarIconButton.tsx',
  'src/browser/MobileBrowserViewModeSwitch.tsx',
  'src/components/AccountUsage.tsx',
  'src/components/ActionSheetModal.tsx',
  'src/components/AgentIcons.tsx',
  'src/components/AuthFailedBanner.tsx',
  'src/components/ConfirmModal.tsx',
  'src/components/ConnectionLog.tsx',
  'src/components/CustomKeyModal.tsx',
  'src/components/DragReorderList.tsx',
  'src/components/HostProtocolGate.tsx',
  'src/components/MobileAgentIcon.tsx',
  'src/components/MobileDictationSetupSheet.tsx',
  'src/components/MobileDiffReviewBody.tsx',
  'src/components/MobileDiffReviewDrawers.tsx',
  'src/components/MobileDiffReviewFileSummary.tsx',
  'src/components/MobileDiffReviewFooter.tsx',
  'src/components/MobileDiffReviewHeader.tsx',
  'src/components/MobileDiffReviewLine.tsx',
  'src/components/MobileHostCard.tsx',
  'src/components/MobileHtmlPreview.tsx',
  'src/components/MobilePRSidebar.tsx',
  'src/components/MobilePrBasePicker.tsx',
  'src/components/MobileRepoIcon.tsx',
  'src/components/MobileRichMarkdownEditor.tsx',
  'src/components/MobileSearchField.tsx',
  'src/components/MobileSyntaxSegments.tsx',
  'src/components/NewWorkspaceFab.tsx',
  'src/components/NewWorktreeModal.tsx',
  'src/components/OrcaLogo.tsx',
  'src/components/PickerListDrawer.tsx',
  'src/components/PickerModal.tsx',
  'src/components/ProtocolBlockScreen.tsx',
  'src/components/RightDrawer.tsx',
  'src/components/SetupHookTrustDrawer.tsx',
  'src/components/SmartWorkspaceAdvancedFields.tsx',
  'src/components/SmartWorkspaceSourceDrawer.tsx',
  'src/components/SmartWorkspaceSourceField.tsx',
  'src/components/SmartWorkspaceSourceRow.tsx',
  'src/components/StatusDot.tsx',
  'src/components/TerminalShortcutSettings.tsx',
  'src/components/TextInputModal.tsx',
  'src/components/VoiceModelList.tsx',
  'src/components/WorkspaceDetailPlaceholder.tsx',
  'src/components/WorktreeAgentRow.tsx',
  'src/components/WorktreeListRow.tsx',
  'src/components/WorktreeMetaGlyphs.tsx',
  'src/components/bottom-drawer-styles.ts',
  'src/components/mobile-diff-review-control-styles.ts',
  'src/components/mobile-diff-review-layout-styles.ts',
  'src/components/mobile-markdown-styles.ts',
  'src/components/mobile-rich-markdown-editor-html.ts',
  'src/components/pr-sidebar/CommentMarkdown.tsx',
  'src/components/pr-sidebar/MermaidDiagram.tsx',
  'src/components/pr-sidebar/MobileLinkPrForm.tsx',
  'src/components/pr-sidebar/MobilePrComposeForm.tsx',
  'src/components/pr-sidebar/MobilePrViewPanel.tsx',
  'src/components/pr-sidebar/PRActionsSection.tsx',
  'src/components/pr-sidebar/PRCheckDetail.tsx',
  'src/components/pr-sidebar/PRChecksSection.tsx',
  'src/components/pr-sidebar/PRCommentCard.tsx',
  'src/components/pr-sidebar/PRCommentComposer.tsx',
  'src/components/pr-sidebar/PRCommentsSection.tsx',
  'src/components/pr-sidebar/PRConflictingFilesSection.tsx',
  'src/components/pr-sidebar/PRReviewersSection.tsx',
  'src/components/pr-sidebar/PRSidebarHeader.tsx',
  'src/components/pr-sidebar/PrSidebarCreateEmptyState.tsx',
  'src/components/pr-sidebar/ReviewerPickerDrawer.tsx',
  'src/components/pr-sidebar/mobile-pr-compose-form-styles.ts',
  'src/components/pr-sidebar/mobile-pr-sidebar-styles.ts',
  'src/components/pr-sidebar/pr-actions-styles.ts',
  'src/components/pr-sidebar/pr-ai-triage-styles.ts',
  'src/components/pr-sidebar/pr-comment-composer-styles.ts',
  'src/components/pr-sidebar/pr-comments-styles.ts',
  'src/components/pr-sidebar/pr-conflict-styles.ts',
  'src/components/pr-sidebar/pr-create-empty-state-styles.ts',
  'src/components/pr-sidebar/pr-sidebar-status-color.ts',
  'src/components/smart-workspace-source-drawer-styles.ts',
  'src/diagnostics/troubleshoot-common-issues.tsx',
  'src/files/MobileFileExplorerPanel.tsx',
  'src/files/MobileFileMarkdownPreview.tsx',
  'src/files/MobileFilePreviewBody.tsx',
  'src/files/MobileFilePreviewScreen.tsx',
  'src/files/mobile-file-explorer-row.tsx',
  'src/files/mobile-file-explorer-styles.ts',
  'src/files/mobile-file-preview-styles.ts',
  'src/onboarding/MobileOnboardingPage.tsx',
  'src/onboarding/mobile-onboarding-styles.ts',
  'src/session/MobileAgentWorkingIndicator.tsx',
  'src/session/MobileNativeChatAsk.tsx',
  'src/session/MobileNativeChatComposer.tsx',
  'src/session/MobileNativeChatMessage.tsx',
  'src/session/MobileNativeChatPermission.tsx',
  'src/session/MobileNativeChatQuestion.tsx',
  'src/session/MobileNativeChatView.tsx',
  'src/session/MobileSessionHeaderIconButton.tsx',
  'src/session/MobileSessionHeaderMoreActionsSheet.tsx',
  'src/session/MobileTerminalInputActions.tsx',
  'src/session/MobileTerminalLiveInputStatus.tsx',
  'src/session/QuickCommandEditorForm.tsx',
  'src/session/QuickCommandsList.tsx',
  'src/session/QuickCommandsSheet.tsx',
  'src/session/mobile-native-chat-message-styles.ts',
  'src/session/mobile-native-chat-view-styles.ts',
  'src/source-control/MobileBranchDiffPreviewDrawer.tsx',
  'src/source-control/MobileCommitFailurePanel.tsx',
  'src/source-control/MobileGitHistoryList.tsx',
  'src/source-control/MobileSourceControlBranchCard.tsx',
  'src/source-control/MobileSourceControlContent.tsx',
  'src/source-control/MobileSourceControlCreatePrEntry.tsx',
  'src/source-control/MobileSourceControlFileRows.tsx',
  'src/source-control/MobileSourceControlHeader.tsx',
  'src/source-control/MobileSourceControlPanel.tsx',
  'src/source-control/MobileSourceControlPrChip.tsx',
  'src/source-control/mobile-source-control-diff-styles.ts',
  'src/source-control/mobile-source-control-hub-styles.ts',
  'src/source-control/mobile-source-control-list-styles.ts',
  'src/source-control/mobile-source-control-screen-state.ts',
  'src/source-control/mobile-source-control-styles.ts',
  'src/terminal/terminal-webview-engine-error-state.tsx',
  'src/terminal/terminal-webview-frame-styles.ts',
  'src/terminal/terminal-webview-html.ts',
  'src/terminal/terminal-webview-theme-injected.ts'
]

const MOBILE_ROOT = path.resolve(__dirname, '../..')
// Matches any relative path ending in mobile-theme (…/theme/mobile-theme or ./mobile-theme).
const BARE_COLORS_IMPORT = /import\s*\{[^}]*\bcolors\b[^}]*\}\s*from\s*['"][^'"]*mobile-theme['"]/
const INLINE_THEMED_STYLES = /useThemedStyles\s*\(\s*(?:\([^)]*\)|[$A-Z_a-z][$\w]*)\s*=>/

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue
    }
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkSourceFiles(full, out)
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) {
      continue
    }
    out.push(full)
  }
  return out
}

function listBareColorsImporters(): string[] {
  const roots = ['app', 'src'].map((segment) => path.join(MOBILE_ROOT, segment))
  const files = roots.flatMap((root) => walkSourceFiles(root))
  return files
    .filter((file) => BARE_COLORS_IMPORT.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(MOBILE_ROOT, file).split(path.sep).join('/'))
    .sort()
}

describe('unthemed color import ratchet', () => {
  it('lists every bare `colors` importer; the baseline may only shrink', () => {
    const actual = listBareColorsImporters()
    const unexpected = actual.filter((p) => !UNTHEMED_COLOR_IMPORTERS.includes(p))
    const convertedButStillListed = UNTHEMED_COLOR_IMPORTERS.filter((p) => !actual.includes(p))
    // Why toEqual([]): failures print the exact offending paths.
    expect(unexpected).toEqual([])
    expect(convertedButStillListed).toEqual([])
  })

  it('forbids inline useThemedStyles(() => …) factories (fresh cache key every render)', () => {
    const roots = ['app', 'src'].map((segment) => path.join(MOBILE_ROOT, segment))
    const offenders = roots
      .flatMap((root) => walkSourceFiles(root))
      .filter((file) => INLINE_THEMED_STYLES.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(MOBILE_ROOT, file).split(path.sep).join('/'))
      .sort()
    expect(offenders).toEqual([])
  })
})
