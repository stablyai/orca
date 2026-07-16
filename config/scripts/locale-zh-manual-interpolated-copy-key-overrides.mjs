// Human-reviewed Simplified Chinese for complete sentences that replace English fragment interpolation.
// Why: CJK grammar cannot safely reuse English verbs, nouns, or plural suffixes as placeholders.
export const ZH_MANUAL_INTERPOLATED_COPY_KEY_OVERRIDES = {
  // Pull request and GitHub item actions.
  'auto.components.PullRequestPage.markFileAsViewed': {
    zh: '将 {{filePath}} 标记为已查看'
  },
  'auto.components.PullRequestPage.unmarkFileAsViewed': {
    zh: '将 {{filePath}} 标记为未查看'
  },
  'auto.components.PullRequestPage.oneReactionAriaLabel': {
    zh: '{{reactionEmoji}} 表情回应，共 {{count}} 次'
  },
  'auto.components.PullRequestPage.manyReactionsAriaLabel': {
    zh: '{{reactionEmoji}} 表情回应，共 {{count}} 次'
  },
  'auto.components.PullRequestPage.confirmClosePullRequestTitle': {
    zh: '关闭拉取请求 #{{number}}？'
  },
  'auto.components.PullRequestPage.closePullRequestConfirmLabel': { zh: '关闭' },
  'auto.components.PullRequestPage.failedToClosePullRequest': { zh: '关闭拉取请求失败' },
  'auto.components.PullRequestPage.confirmReopenPullRequestTitle': {
    zh: '重新打开拉取请求 #{{number}}？'
  },
  'auto.components.PullRequestPage.reopenPullRequestConfirmLabel': { zh: '重新打开' },
  'auto.components.PullRequestPage.failedToReopenPullRequest': {
    zh: '重新打开拉取请求失败'
  },
  'auto.components.PullRequestPage.squashAndMergeLabel': { zh: '压缩并合并' },
  'auto.components.PullRequestPage.createMergeCommitLabel': { zh: '创建合并提交' },
  'auto.components.PullRequestPage.rebaseAndMergeLabel': { zh: '变基并合并' },
  'auto.components.PullRequestPage.confirmSquashAndMergeTitle': {
    zh: '压缩并合并拉取请求 #{{number}}？'
  },
  'auto.components.PullRequestPage.confirmCreateMergeCommitTitle': {
    zh: '为拉取请求 #{{number}} 创建合并提交？'
  },
  'auto.components.PullRequestPage.confirmRebaseAndMergeTitle': {
    zh: '变基并合并拉取请求 #{{number}}？'
  },
  'auto.components.GitHubItemDialog.markFileAsViewed': {
    zh: '将 {{filePath}} 标记为已查看'
  },
  'auto.components.GitHubItemDialog.unmarkFileAsViewed': {
    zh: '将 {{filePath}} 标记为未查看'
  },
  'auto.components.GitHubItemDialog.oneReactionAriaLabel': {
    zh: '{{reactionEmoji}} 表情回应，共 {{count}} 次'
  },
  'auto.components.GitHubItemDialog.manyReactionsAriaLabel': {
    zh: '{{reactionEmoji}} 表情回应，共 {{count}} 次'
  },
  'auto.components.GitHubItemDialog.confirmClosePullRequestTitle': {
    zh: '关闭拉取请求 #{{number}}？'
  },
  'auto.components.GitHubItemDialog.closePullRequestConfirmLabel': { zh: '关闭' },
  'auto.components.GitHubItemDialog.failedToClosePullRequest': { zh: '关闭拉取请求失败' },
  'auto.components.GitHubItemDialog.confirmReopenPullRequestTitle': {
    zh: '重新打开拉取请求 #{{number}}？'
  },
  'auto.components.GitHubItemDialog.reopenPullRequestConfirmLabel': { zh: '重新打开' },
  'auto.components.GitHubItemDialog.failedToReopenPullRequest': {
    zh: '重新打开拉取请求失败'
  },
  'auto.components.GitHubItemDialog.squashAndMergeLabel': { zh: '压缩并合并' },
  'auto.components.GitHubItemDialog.createMergeCommitLabel': { zh: '创建合并提交' },
  'auto.components.GitHubItemDialog.rebaseAndMergeLabel': { zh: '变基并合并' },
  'auto.components.GitHubItemDialog.confirmSquashAndMergeTitle': {
    zh: '压缩并合并拉取请求 #{{number}}？'
  },
  'auto.components.GitHubItemDialog.confirmCreateMergeCommitTitle': {
    zh: '为拉取请求 #{{number}} 创建合并提交？'
  },
  'auto.components.GitHubItemDialog.confirmRebaseAndMergeTitle': {
    zh: '变基并合并拉取请求 #{{number}}？'
  },

  // Task counts and source-control operations.
  'auto.components.TaskPage.oneSelectedMember': { zh: '{{count}} 名成员' },
  'auto.components.TaskPage.manySelectedMembers': { zh: '{{count}} 名成员' },
  'auto.components.TaskPage.oneSelectedLabel': { zh: '{{count}} 个标签' },
  'auto.components.TaskPage.manySelectedLabels': { zh: '{{count}} 个标签' },
  'auto.components.TaskPage.startWorkspaceFromGitLabMR': {
    zh: '从 MR {{number}} 启动工作区'
  },
  'auto.components.TaskPage.startWorkspaceFromGitLabIssue': {
    zh: '从议题 {{number}} 启动工作区'
  },
  'auto.components.right.sidebar.SourceControl.failedToDiscardOneFile': {
    zh: '放弃 {{count}} 个文件的更改失败'
  },
  'auto.components.right.sidebar.SourceControl.failedToDiscardManyFiles': {
    zh: '放弃 {{count}} 个文件的更改失败'
  },
  'auto.components.right.sidebar.SourceControl.oneNote': { zh: '{{count}} 条笔记' },
  'auto.components.right.sidebar.SourceControl.manyNotes': { zh: '{{count}} 条笔记' },
  'auto.components.right.sidebar.SourceControl.abortRebaseTitle': { zh: '中止变基？' },
  'auto.components.right.sidebar.SourceControl.abortRebaseDescription': {
    zh: '这将取消正在进行的变基，并可能丢失本次变基中已完成的冲突解决结果。'
  },
  'auto.components.right.sidebar.SourceControl.abortRebaseConfirmLabel': { zh: '中止变基' },
  'auto.components.right.sidebar.SourceControl.abortRebaseFailed': { zh: '中止变基失败' },
  'auto.components.right.sidebar.SourceControl.failedToAbortRebase': { zh: '无法中止变基' },
  'auto.components.right.sidebar.SourceControl.abortMergeTitle': { zh: '中止合并？' },
  'auto.components.right.sidebar.SourceControl.abortMergeDescription': {
    zh: '这将取消正在进行的合并，并可能丢失本次合并中已完成的冲突解决结果。'
  },
  'auto.components.right.sidebar.SourceControl.abortMergeConfirmLabel': { zh: '中止合并' },
  'auto.components.right.sidebar.SourceControl.abortMergeFailed': { zh: '中止合并失败' },
  'auto.components.right.sidebar.SourceControl.failedToAbortMerge': { zh: '无法中止合并' },

  // Settings, onboarding, ports, and uploads.
  'auto.components.settings.SshPane.syncedOneServer': { zh: '已同步 {{count}} 台服务器' },
  'auto.components.settings.SshPane.syncedManyServers': { zh: '已同步 {{count}} 台服务器' },
  'auto.components.sidebar.AddRemoteHostDialog.sshImportSyncedOneHost': {
    zh: '已同步 {{count}} 台 SSH 主机。'
  },
  'auto.components.sidebar.AddRemoteHostDialog.sshImportSyncedManyHosts': {
    zh: '已同步 {{count}} 台 SSH 主机。'
  },
  'auto.components.onboarding.IntegrationsStep.oneWorkspaceLinked': {
    zh: '已关联 {{count}} 个工作区。可随时添加其他工作区，或替换受限密钥。'
  },
  'auto.components.onboarding.IntegrationsStep.manyWorkspacesLinked': {
    zh: '已关联 {{count}} 个工作区。可随时添加其他工作区，或替换受限密钥。'
  },
  'auto.components.settings.task.tracker.integration.cards.oneJiraSiteConnected': {
    zh: '已连接 {{count}} 个站点'
  },
  'auto.components.settings.task.tracker.integration.cards.manyJiraSitesConnected': {
    zh: '已连接 {{count}} 个站点'
  },
  'auto.components.settings.task.tracker.integration.cards.oneLinearWorkspaceConnected': {
    zh: '已连接 {{count}} 个工作区'
  },
  'auto.components.settings.task.tracker.integration.cards.manyLinearWorkspacesConnected': {
    zh: '已连接 {{count}} 个工作区'
  },
  'auto.components.terminal.pane.terminal.drop.handler.skippedOneSymlink': {
    zh: '已跳过 {{count}} 个符号链接。'
  },
  'auto.components.terminal.pane.terminal.drop.handler.skippedManySymlinks': {
    zh: '已跳过 {{count}} 个符号链接。'
  },
  'auto.components.terminal.pane.terminal.drop.handler.skippedOneItem': {
    zh: '已跳过 {{count}} 项。'
  },
  'auto.components.terminal.pane.terminal.drop.handler.skippedManyItems': {
    zh: '已跳过 {{count}} 项。'
  },
  'auto.components.terminal.pane.terminal.drop.handler.failedToUploadOneFile': {
    zh: '上传 {{count}} 个文件失败。'
  },
  'auto.components.terminal.pane.terminal.drop.handler.failedToUploadManyFiles': {
    zh: '上传 {{count}} 个文件失败。'
  },
  'auto.components.terminal.pane.terminal.drop.handler.uploadingOneFileToRuntime': {
    zh: '正在向运行环境上传 {{count}} 个文件…'
  },
  'auto.components.terminal.pane.terminal.drop.handler.uploadingManyFilesToRuntime': {
    zh: '正在向运行环境上传 {{count}} 个文件…'
  },
  'auto.components.terminal.pane.terminal.drop.handler.uploadingOneFileToRemote': {
    zh: '正在向远程主机上传 {{count}} 个文件…'
  },
  'auto.components.terminal.pane.terminal.drop.handler.uploadingManyFilesToRemote': {
    zh: '正在向远程主机上传 {{count}} 个文件…'
  },
  'auto.components.GitLabItemDialog.approvedWithRequirement': {
    zh: '已批准 · 共需 {{requiredCount}} 次批准'
  },
  'auto.components.GitLabItemDialog.oneApprovalRemainingOfRequired': {
    zh: '还需 {{remainingCount}} 次批准（共需 {{requiredCount}} 次）'
  },
  'auto.components.GitLabItemDialog.manyApprovalsRemainingOfRequired': {
    zh: '还需 {{remainingCount}} 次批准（共需 {{requiredCount}} 次）'
  },
  'auto.components.GitLabItemDialog.oneApprovalRemaining': {
    zh: '还需 {{remainingCount}} 次批准'
  },
  'auto.components.GitLabItemDialog.manyApprovalsRemaining': {
    zh: '还需 {{remainingCount}} 次批准'
  },
  'auto.components.onboarding.RepoStepNestedImportPanel.scanningFoundOneRepository': {
    zh: '扫描中… 已在此文件夹中发现 {{count}} 个仓库。'
  },
  'auto.components.onboarding.RepoStepNestedImportPanel.scanningFoundManyRepositories': {
    zh: '扫描中… 已在此文件夹中发现 {{count}} 个仓库。'
  },
  'auto.components.onboarding.RepoStepNestedImportPanel.foundOneRepository': {
    zh: '已在此文件夹中发现 {{count}} 个仓库。'
  },
  'auto.components.onboarding.RepoStepNestedImportPanel.foundManyRepositories': {
    zh: '已在此文件夹中发现 {{count}} 个仓库。'
  },
  'auto.lib.launch.agent.in.new.tab.promptDeliveryTimedOut': {
    zh: '提示词未能发送；请在智能体就绪后手动粘贴。'
  },
  'auto.lib.launch.agent.in.new.tab.notesDeliveryTimedOut': {
    zh: '笔记未能发送；请在智能体就绪后手动粘贴。'
  },
  'auto.components.floating.terminal.FloatingTerminalToggleButton.minimizeFloatingWorkspaceWithShortcut':
    {
      zh: '最小化浮动工作区（{{shortcut}}）'
    },
  'auto.components.floating.terminal.FloatingTerminalToggleButton.showFloatingWorkspaceWithShortcut':
    {
      zh: '显示浮动工作区（{{shortcut}}）'
    },
  'auto.components.status.bar.PortsStatusSegment.oneWorkspacePortAriaLabel': {
    zh: '端口：{{workspaceCount}} 个工作区端口'
  },
  'auto.components.status.bar.PortsStatusSegment.manyWorkspacePortsAriaLabel': {
    zh: '端口：{{workspaceCount}} 个工作区端口'
  },
  'auto.components.status.bar.PortsStatusSegment.oneWorkspacePortTooltip': {
    zh: '端口：{{workspaceCount}} 个工作区端口'
  },
  'auto.components.status.bar.PortsStatusSegment.manyWorkspacePortsTooltip': {
    zh: '端口：{{workspaceCount}} 个工作区端口'
  },
  'auto.components.status.bar.PortsStatusSegment.oneWorkspacePortWithExternalTooltip': {
    zh: '端口：{{workspaceCount}} 个工作区端口 · {{externalCount}} 个外部端口'
  },
  'auto.components.status.bar.PortsStatusSegment.manyWorkspacePortsWithExternalTooltip': {
    zh: '端口：{{workspaceCount}} 个工作区端口 · {{externalCount}} 个外部端口'
  },

  // Conflict status and file operations.
  'auto.components.editor.ConflictComponents.ec7ef38d67': { zh: '未解决' },
  'auto.components.editor.ConflictComponents.485ab716f0': { zh: '已在本地解决' },
  'auto.components.editor.ConflictComponents.71a2c63628': { zh: '双方均已修改' },
  'auto.components.editor.ConflictComponents.ba602cdc05': { zh: '双方均已添加' },
  'auto.components.editor.ConflictComponents.1c55f94973': { zh: '我方已删除' },
  'auto.components.editor.ConflictComponents.9d8757e1ca': { zh: '对方已删除' },
  'auto.components.editor.ConflictComponents.36bceb6bb5': { zh: '我方已添加' },
  'auto.components.editor.ConflictComponents.5259d6908a': { zh: '对方已添加' },
  'auto.components.editor.ConflictComponents.be2b3274fe': { zh: '双方均已删除' },
  'auto.components.editor.ConflictComponents.b119865c75': { zh: '解决冲突标记' },
  'auto.components.editor.ConflictComponents.5e89c1d824': {
    zh: '选择要保留的版本，或合并两个版本'
  },
  'auto.components.editor.ConflictComponents.7e6a9cd8ba': { zh: '决定是否恢复此文件' },
  'auto.components.editor.ConflictComponents.9d73608d56': {
    zh: '决定保留此文件还是接受删除'
  },
  'auto.components.editor.ConflictComponents.2ff72311cd': {
    zh: '检查并决定是否保留新增文件'
  },
  'auto.components.editor.ConflictComponents.7e15338be9': {
    zh: '保留前请检查对方添加的文件'
  },
  'auto.components.editor.ConflictComponents.a63bf70fc7': {
    zh: '请先在 Git 中解决此冲突，或恢复任一版本后再编辑'
  },
  'auto.lib.launch.work.item.direct.agent.20015b902a': {
    zh: '智能体启动时间过长。工作区已就绪，请在智能体空闲时粘贴提示词。'
  },
  'auto.lib.launch.work.item.direct.agent.33640ddfa0': {
    zh: '智能体启动时间过长。工作区已就绪，请在智能体空闲时粘贴工作项上下文。'
  },
  'auto.components.right.sidebar.file.deletion.localized.copy.222a8a3fb3': {
    zh: '删除“{{value0}}”失败。'
  },
  'auto.components.right.sidebar.file.deletion.localized.copy.e9605383fd': {
    zh: '将“{{value0}}”移至回收站失败。'
  },
  'auto.components.right.sidebar.file.deletion.localized.copy.f5fbc0837d': {
    zh: '将“{{value0}}”移至废纸篓失败。'
  },
  'auto.components.right.sidebar.file.deletion.localized.copy.f583bf91df': {
    zh: '远程文件和文件夹会被永久删除且无法撤销；本地文件和文件夹会移至回收站。'
  },
  'auto.components.right.sidebar.file.deletion.localized.copy.b1bde1b2e4': {
    zh: '远程文件和文件夹会被永久删除且无法撤销；本地文件和文件夹会移至废纸篓。'
  },
  'auto.components.right.sidebar.useFileExplorerImport.4222b43cc1': {
    zh: '导入 {{count}} 个文件失败。'
  },
  'auto.components.right.sidebar.useFileExplorerImport.576340ce05': {
    zh: '导入 {{count}} 个文件失败。'
  },
  'auto.components.right.sidebar.useFileExplorerImport.d68e492480': {
    zh: '已跳过 {{count}} 个文件。'
  },
  'auto.components.right.sidebar.useFileExplorerImport.17be0f9168': {
    zh: '已跳过 {{count}} 个文件。'
  },
  'auto.components.right.sidebar.useFileExplorerImport.58220fc4bb': {
    zh: '导入文件失败。'
  },
  'auto.components.right.sidebar.source.control.dropdown.items.ac19d0917c': {
    zh: '中止变基'
  },
  'auto.components.right.sidebar.source.control.dropdown.items.515a94f9f6': {
    zh: '中止合并'
  },
  'auto.components.right.sidebar.source.control.dropdown.items.f48d7f6445': {
    zh: '操作正在进行…'
  },
  'auto.components.right.sidebar.source.control.dropdown.items.62e79d363d': {
    zh: '中止正在进行的变基'
  },
  'auto.components.right.sidebar.source.control.dropdown.items.4ef3aa6987': {
    zh: '中止正在进行的合并'
  },
  'auto.components.right.sidebar.diff.comments.clear.dialog.state.f07232e970': {
    zh: '清除该工作区中的 {{count}} 条笔记？'
  },
  'auto.components.right.sidebar.diff.comments.clear.dialog.state.d10b0441e0': {
    zh: '清除该工作区中的 {{count}} 条笔记？'
  },
  'auto.components.right.sidebar.diff.comments.clear.dialog.state.bd98da62a0': {
    zh: '清除 {{value0}} 中的 {{count}} 条笔记？'
  },
  'auto.components.right.sidebar.diff.comments.clear.dialog.state.edd639023e': {
    zh: '清除 {{value0}} 中的 {{count}} 条笔记？'
  },

  // Hosted review state copy.
  'auto.components.right.sidebar.HostedReviewActions.pullRequestLabel': { zh: '拉取请求' },
  'auto.components.right.sidebar.HostedReviewActions.mergeRequestLabel': { zh: '合并请求' },
  'auto.components.right.sidebar.HostedReviewActions.57fb10cfe7': {
    zh: '关闭 {{value0}}？'
  },
  'auto.components.right.sidebar.HostedReviewActions.b982b128c0': {
    zh: '重新打开 {{value0}}？'
  },
  'auto.components.right.sidebar.HostedReviewActions.a3d572a4de': {
    zh: '这会关闭{{value0}}。'
  },
  'auto.components.right.sidebar.HostedReviewActions.78f5ff294c': {
    zh: '这会重新打开{{value0}}。'
  },
  'auto.components.right.sidebar.HostedReviewActions.73e5cc9c99': { zh: '关闭' },
  'auto.components.right.sidebar.HostedReviewActions.641c8ec02a': { zh: '重新打开' },
  'auto.components.right.sidebar.HostedReviewActions.72c9a274a7': {
    zh: '关闭{{value0}}失败。'
  },
  'auto.components.right.sidebar.HostedReviewActions.93afca5395': {
    zh: '重新打开{{value0}}失败。'
  },
  'auto.components.right.sidebar.HostedReviewActions.reviewClosedToast': {
    zh: '{{value0}} 已关闭'
  },
  'auto.components.right.sidebar.HostedReviewActions.377269db6f': {
    zh: '{{value0}} 已重新打开'
  },

  // Remaining count announcements and localized labels.
  'auto.components.editor.CombinedDiffViewer.showOneAiNote': {
    zh: '显示 {{count}} 条 AI 笔记'
  },
  'auto.components.editor.CombinedDiffViewer.showManyAiNotes': {
    zh: '显示 {{count}} 条 AI 笔记'
  },
  'auto.components.WorktreeJumpPalette.oneResultFoundWithCreateAction': {
    zh: '找到 1 个结果；可以创建工作树'
  },
  'auto.components.WorktreeJumpPalette.oneResultFound': { zh: '找到 1 个结果' },
  'auto.components.WorktreeJumpPalette.manyResultsFoundWithCreateAction': {
    zh: '找到 {{count}} 个结果；可以创建工作树'
  },
  'auto.components.WorktreeJumpPalette.manyResultsFound': {
    zh: '找到 {{count}} 个结果'
  },
  'auto.components.WorktreeJumpPalette.oneItemAvailableWithCreateAction': {
    zh: '有 1 项可用；可以创建工作树'
  },
  'auto.components.WorktreeJumpPalette.oneItemAvailable': { zh: '有 1 项可用' },
  'auto.components.WorktreeJumpPalette.manyItemsAvailableWithCreateAction': {
    zh: '有 {{count}} 项可用；可以创建工作树'
  },
  'auto.components.WorktreeJumpPalette.manyItemsAvailable': {
    zh: '有 {{count}} 项可用'
  },
  'auto.components.LinearIssueWorkspace.localCommentAuthor': { zh: '你' },
  'auto.components.LinearIssueWorkspace.identifierCopyLabel': { zh: '标识符' },
  'auto.components.LinearIssueWorkspace.suggestedBranchNameCopyLabel': {
    zh: '建议的分支名称'
  },
  'auto.components.LinearIssueWorkspace.promptCopyLabel': { zh: '提示词' },
  'auto.components.JiraIssueWorkspace.localCommentAuthor': { zh: '你' },
  'auto.components.JiraIssueWorkspace.keyCopyLabel': { zh: '议题编号' },
  'auto.components.JiraIssueWorkspace.branchNameCopyLabel': { zh: '分支名称' },
  'auto.components.JiraIssueWorkspace.promptCopyLabel': { zh: '提示词' },
  'auto.components.LinearItemDrawer.localCommentAuthor': { zh: '你' }
}
