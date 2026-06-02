## Completed

| File | Cleanup |
|---|---|
| `src/renderer/src/components/settings/NotificationsPane.tsx` | Removed `eslint-disable max-lines`; extracted `NotificationSettingToggle.tsx`; verified with focused `oxlint`, `typecheck:web`, and focused Vitest batch. |
| `src/renderer/src/lib/agent-catalog.tsx` | Removed `eslint-disable max-lines`; extracted agent SVG/fallback glyphs to `agent-icon-glyphs.tsx`; verified with focused `oxlint`, `typecheck:web`, and focused Vitest batch. |
| `src/renderer/src/components/editor/CombinedDiffFileTree.tsx` | Removed `eslint-disable max-lines`; extracted row rendering/drag behavior to `combined-diff-file-tree-row.tsx`; verified with focused `oxlint`, `typecheck:web`, and focused Vitest batch. |
| `src/renderer/src/components/status-bar/PortsStatusSegment.tsx` | Removed `eslint-disable max-lines`; extracted popover row/action rendering to `ports-status-popover-rows.tsx`; verified with focused `oxlint` and `typecheck:web`. |
| `src/renderer/src/components/settings/BrowserUsePane.tsx` | Removed `eslint-disable max-lines`; extracted `BrowserUseEnableSwitch.tsx` and `BrowserUseComputerUseNotice.tsx`; verified with focused `oxlint` and `typecheck:web`. |
| `src/renderer/src/components/feature-wall/FeatureWallTourSurface.tsx` | Removed `eslint-disable max-lines`; extracted tour keyboard shortcut and rail keydown hooks; verified with focused `oxlint` and `typecheck:web`. |
| `src/renderer/src/components/right-sidebar/CreatePullRequestDialog.tsx` | Removed `eslint-disable max-lines`; extracted `CreatePullRequestGenerateButton.tsx`; verified with focused `oxlint`, `typecheck:web`, and focused Vitest batch. |
| `src/renderer/src/components/settings/TerminalAppearanceSection.tsx` | Removed `eslint-disable max-lines`; extracted `TerminalFontSizeSetting.tsx`; verified with focused `oxlint`, `typecheck:web`, and focused Vitest batch. |
| `src/renderer/src/components/right-sidebar/HostedReviewActions.tsx` | Removed `eslint-disable max-lines`; extracted GitLab MR merge presentation to `gitlab-mr-merge-state.ts`; verified with focused `oxlint` and `typecheck:web`. |
| `src/renderer/src/components/settings/RuntimePairingUrlGenerator.tsx` | Removed `eslint-disable max-lines`; extracted generated URL rows to `RuntimePairingGeneratedUrlRows.tsx`; verified with focused `oxlint` and `typecheck:web`. |
| `src/renderer/src/components/stats/UsageOverviewPane.tsx` | Removed `eslint-disable max-lines`; extracted overview display sections to `usage-overview-sections.tsx`; verified with focused `oxlint`, `typecheck:web`, and the usage overview model test. |
| `src/renderer/src/components/settings/ManageSessionsSection.tsx` | Removed `eslint-disable max-lines`; extracted the kill-session confirmation dialog to `ManageSessionKillDialog.tsx`; verified with focused `oxlint`, `typecheck:web`, and the configured Vitest run. |
| `src/renderer/src/components/settings/AutoRenameBranchFromWorkSetting.tsx` | Removed `eslint-disable max-lines`; extracted the branch prompt editor to `AutoRenameBranchPromptEditor.tsx`; verified with focused `oxlint`, `typecheck:web`, and the configured Vitest run. |
| `src/renderer/src/components/sidebar/AddRepoSteps.tsx` | Removed `eslint-disable max-lines`; extracted the remote-project step to `AddRepoRemoteStep.tsx`; verified with focused `oxlint`, `typecheck:web`, and the configured Vitest run. |

## Remaining

| File | Counted/max | Over | Raw lines | Suppression |
|---|---:|---:|---:|---|
| `mobile/app/h/[hostId]/tasks.tsx` | 14682/400 | +14282 | 15156 | `none` |
| `src/renderer/src/components/TaskPage.tsx` | 8981/400 | +8581 | 9806 | `eslint-disable` |
| `src/renderer/src/components/right-sidebar/SourceControl.tsx` | 6195/400 | +5795 | 6916 | `eslint-disable` |
| `src/renderer/src/components/GitHubItemDialog.tsx` | 5705/400 | +5305 | 6157 | `eslint-disable` |
| `src/renderer/src/components/PullRequestPage.tsx` | 5485/400 | +5085 | 5921 | `eslint-disable` |
| `mobile/app/h/[hostId]/session/[worktreeId].tsx` | 4988/400 | +4588 | 5434 | `none` |
| `src/renderer/src/components/browser-pane/BrowserPane.tsx` | 4623/400 | +4223 | 5119 | `eslint-disable` |
| `src/renderer/src/components/sidebar/WorktreeList.tsx` | 4217/400 | +3817 | 4655 | `eslint-disable` |
| `src/renderer/src/components/right-sidebar/ChecksPanel.tsx` | 2440/400 | +2040 | 2603 | `eslint-disable` |
| `mobile/src/terminal/TerminalWebView.tsx` | 2054/400 | +1654 | 2233 | `none` |
| `mobile/app/h/[hostId]/source-control/[worktreeId].tsx` | 2004/400 | +1604 | 2088 | `none` |
| `src/renderer/src/components/editor/RichMarkdownEditor.tsx` | 1815/400 | +1415 | 2040 | `eslint-disable` |
| `src/renderer/src/components/editor/MarkdownPreview.tsx` | 1716/400 | +1316 | 1906 | `eslint-disable` |
| `src/renderer/src/components/Terminal.tsx` | 1657/400 | +1257 | 1988 | `eslint-disable` |
| `src/renderer/src/components/status-bar/WorkspaceSpaceManagerPanel.tsx` | 1654/400 | +1254 | 1740 | `eslint-disable` |
| `src/renderer/src/components/right-sidebar/checks-panel-content.tsx` | 1645/400 | +1245 | 1735 | `eslint-disable` |
| `src/renderer/src/App.tsx` | 1644/400 | +1244 | 2076 | `eslint-disable` |
| `src/renderer/src/components/activity/ActivityPrototypePage.tsx` | 1630/400 | +1230 | 1845 | `eslint-disable` |
| `src/renderer/src/components/terminal-pane/TerminalPane.tsx` | 1624/400 | +1224 | 1977 | `eslint-disable` |
| `mobile/app/h/[hostId]/index.tsx` | 1603/400 | +1203 | 1755 | `none` |
| `src/renderer/src/components/status-bar/StatusBar.tsx` | 1600/400 | +1200 | 1781 | `eslint-disable` |
| `mobile/src/browser/MobileBrowserPane.tsx` | 1594/400 | +1194 | 1685 | `none` |
| `src/renderer/src/components/GitLabItemDialog.tsx` | 1433/400 | +1033 | 1502 | `eslint-disable` |
| `mobile/app/index.tsx` | 1419/400 | +1019 | 1566 | `none` |
| `src/renderer/src/components/settings/CommitMessageAiPane.tsx` | 1373/400 | +973 | 1443 | `eslint-disable` |
| `src/renderer/src/components/editor/CombinedDiffViewer.tsx` | 1366/400 | +966 | 1509 | `eslint-disable` |
| `src/renderer/src/components/LinearItemDrawer.tsx` | 1329/400 | +929 | 1411 | `eslint-disable` |
| `src/renderer/src/components/status-bar/ResourceUsageStatusSegment.tsx` | 1329/400 | +929 | 1522 | `eslint-disable` |
| `src/renderer/src/components/sidebar/AddRepoDialog.tsx` | 1320/400 | +920 | 1412 | `eslint-disable` |
| `src/renderer/src/components/WorktreeJumpPalette.tsx` | 1313/400 | +913 | 1496 | `oxlint-disable` |
| `mobile/src/components/NewWorktreeModal.tsx` | 1263/400 | +863 | 1352 | `none` |
| `src/renderer/src/components/new-workspace/SmartWorkspaceNameField.tsx` | 1211/400 | +811 | 1341 | `eslint-disable` |
| `src/renderer/src/components/right-sidebar/PortsPanel.tsx` | 1188/400 | +788 | 1287 | `oxlint-disable` |
| `src/renderer/src/components/settings/AccountsPane.tsx` | 1130/400 | +730 | 1191 | `eslint-disable` |
| `src/renderer/src/components/settings/GeneralPane.tsx` | 1098/400 | +698 | 1231 | `eslint-disable` |
| `src/renderer/src/components/settings/Settings.tsx` | 1092/400 | +692 | 1224 | `eslint-disable` |
| `src/renderer/src/components/workspace-cleanup/WorkspaceCleanupDialog.tsx` | 1076/400 | +676 | 1123 | `eslint-disable` |
| `src/renderer/src/components/github-project/ProjectViewWrapper.tsx` | 1015/400 | +615 | 1147 | `eslint-disable` |
| `src/renderer/src/components/sidebar/WorktreeCard.tsx` | 963/400 | +563 | 1077 | `eslint-disable` |
| `src/renderer/src/components/settings/RepositoryHooksSection.tsx` | 958/400 | +558 | 1034 | `eslint-disable` |
| `src/renderer/src/components/github-project/ProjectCell.tsx` | 939/400 | +539 | 1029 | `eslint-disable` |
| `src/renderer/src/components/editor/IpynbViewer.tsx` | 888/400 | +488 | 948 | `eslint-disable` |
| `src/renderer/src/components/feature-wall/BrowserAnimatedVisual.tsx` | 882/400 | +482 | 969 | `eslint-disable` |
| `src/renderer/src/components/LinearIssueWorkspace.tsx` | 838/400 | +438 | 887 | `eslint-disable` |
| `src/renderer/src/components/editor/EditorContent.tsx` | 795/400 | +395 | 886 | `eslint-disable` |
| `src/renderer/src/components/feature-wall/EditorAnimatedVisual.tsx` | 758/400 | +358 | 840 | `eslint-disable` |
| `src/renderer/src/components/feature-wall/WorkbenchAnimatedVisual.tsx` | 757/400 | +357 | 846 | `eslint-disable` |
| `src/renderer/src/components/UpdateCard.tsx` | 733/400 | +333 | 924 | `eslint-disable` |
| `src/renderer/src/components/JiraIssueWorkspace.tsx` | 715/400 | +315 | 750 | `eslint-disable` |
| `src/renderer/src/components/github-project/ProjectPicker.tsx` | 713/400 | +313 | 775 | `eslint-disable` |
| `src/renderer/src/components/linear-project-view-surfaces.tsx` | 708/400 | +308 | 740 | `eslint-disable` |
| `src/renderer/src/components/editor/MonacoEditor.tsx` | 688/400 | +288 | 824 | `eslint-disable` |
| `src/renderer/src/components/NewWorkspaceComposerCard.tsx` | 674/400 | +274 | 751 | `eslint-disable` |
| `src/renderer/src/components/settings/TerminalPane.tsx` | 660/400 | +260 | 686 | `eslint-disable` |
| `mobile/src/components/CustomKeyModal.tsx` | 645/400 | +245 | 685 | `none` |
| `src/renderer/src/components/sidebar/WorktreeContextMenu.tsx` | 634/400 | +234 | 691 | `eslint-disable` |
| `src/renderer/src/components/sidebar/RemoteFileBrowser.tsx` | 629/400 | +229 | 751 | `eslint-disable` |
| `src/renderer/src/components/settings/SettingsFormControls.tsx` | 621/400 | +221 | 687 | `eslint-disable` |
| `src/renderer/src/components/settings/IntegrationsPane.tsx` | 617/400 | +217 | 652 | `eslint-disable` |
| `src/renderer/src/components/right-sidebar/FileExplorerRow.tsx` | 565/400 | +165 | 618 | `eslint-disable` |
| `src/renderer/src/components/sidebar/WorkspaceKanbanDrawer.tsx` | 565/400 | +165 | 607 | `eslint-disable` |
| `src/renderer/src/components/settings/RuntimeEnvironmentsPane.tsx` | 558/400 | +158 | 578 | `eslint-disable` |
| `src/renderer/src/components/settings/AgentsPane.tsx` | 548/400 | +148 | 615 | `eslint-disable` |
| `src/renderer/src/components/feature-wall/FeatureWallSetupStepVisuals.tsx` | 534/400 | +134 | 574 | `eslint-disable` |
| `mobile/app/pair-scan.tsx` | 531/400 | +131 | 577 | `none` |
| `src/renderer/src/components/settings/RepositorySourceControlAiSection.tsx` | 529/400 | +129 | 563 | `eslint-disable` |
| `src/renderer/src/components/right-sidebar/FileExplorer.tsx` | 515/400 | +115 | 562 | `eslint-disable` |
| `mobile/app/terminal-settings.tsx` | 514/400 | +114 | 554 | `none` |
| `src/renderer/src/components/diff-comments/useDiffCommentDecorator.tsx` | 506/400 | +106 | 728 | `eslint-disable` |
| `src/renderer/src/components/editor/DiffSectionItem.tsx` | 498/400 | +98 | 556 | `eslint-disable` |
| `src/renderer/src/components/tab-bar/EditorFileTab.tsx` | 489/400 | +89 | 528 | `eslint-disable` |
| `src/renderer/src/components/feature-wall/SetupScriptAnimatedVisual.tsx` | 475/400 | +75 | 512 | `eslint-disable` |
| `src/renderer/src/components/sidebar/WorktreeCardMeta.tsx` | 472/400 | +72 | 505 | `eslint-disable` |
| `src/renderer/src/components/automations/AutomationEditorDialog.tsx` | 467/400 | +67 | 480 | `eslint-disable` |
| `src/renderer/src/components/dashboard/DashboardAgentRow.tsx` | 459/400 | +59 | 651 | `eslint-disable` |
| `src/renderer/src/components/editor/rich-markdown-commands.tsx` | 455/400 | +55 | 547 | `eslint-disable` |
| `mobile/app/troubleshoot.tsx` | 436/400 | +36 | 463 | `none` |
| `src/renderer/src/components/mobile/MobilePage.tsx` | 433/400 | +33 | 501 | `eslint-disable` |
| `mobile/app/h/[hostId]/files/[worktreeId].tsx` | 402/400 | +2 | 420 | `none` |
