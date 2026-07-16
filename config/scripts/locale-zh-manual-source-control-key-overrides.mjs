// Human-reviewed Simplified Chinese for right-sidebar source control, checks, and repository tooling.
// Why: these strings need key-level context; broad phrase replacement would corrupt code tokens.
export const ZH_MANUAL_SOURCE_CONTROL_KEY_OVERRIDES = {
  // Right sidebar, source control, checks, and repository tooling.
  'auto.components.right.sidebar.BulkActionBar.ef5f5bd06e': { zh: '暂存（' },
  'auto.components.right.sidebar.SearchHeader.464ae3974f': { zh: '区分大小写' },
  'auto.components.right.sidebar.SearchResultItems.cc06595a3b': { zh: '复制带行号的路径' },
  'auto.components.right.sidebar.PortsPanel.17bea6e391': { zh: 'localhost' },
  'auto.components.right.sidebar.PortsPanel.5dd86dcf2f': { zh: '进程' },
  'auto.components.right.sidebar.PortsPanel.729be0b4e5': { zh: '类型' },
  'auto.components.right.sidebar.PortsPanel.935dda7718': { zh: '当前工作区' },
  'auto.components.right.sidebar.PortsPanel.c9d106547a': { zh: '转发' },
  'auto.components.right.sidebar.PortsPanel.d32820d3e2': { zh: '外部' },
  'auto.components.right.sidebar.PortsPanel.ddbe58d74e': { zh: '已转发' },
  'auto.components.right.sidebar.AiVaultPanel.originalPaneUnavailable': { zh: '原窗格已不可用。' },
  'auto.components.right.sidebar.AiVaultPanel.transcriptsSkipped': {
    zh: '已跳过 {{count}} 份对话记录'
  },
  'auto.components.right.sidebar.AiVaultSessionDetails.jumpToOriginalPane': { zh: '跳转到原面板' },
  'auto.components.right.sidebar.AiVaultSessionDetails.noReadablePreview': {
    zh: '此对话记录中没有可读的消息预览。'
  },
  'auto.components.right.sidebar.AiVaultSessionDetails.originalAsk': { zh: '初始请求' },
  'auto.components.right.sidebar.AiVaultSessionDetails.revealLog': { zh: '在文件夹中显示日志' },
  'auto.components.right.sidebar.AiVaultSessionDetails.subagentTranscripts': {
    zh: '{{value0}} 份子智能体对话记录'
  },
  'auto.components.right.sidebar.AiVaultSessionRow.jumpToOriginalPane': { zh: '跳转到原面板' },
  'auto.components.right.sidebar.AiVaultSessionRow.revealLog': { zh: '在文件夹中显示日志' },
  'auto.components.right.sidebar.FileExplorerRow.0fec99bfd7': { zh: '创建副本' },
  'auto.components.right.sidebar.GitHistoryPanel.8232c8b2f2': {
    zh: '打开提交 {{value0}}：{{value1}}'
  },
  'auto.components.right.sidebar.GitHistoryPanel.9f7535d22b': {
    zh: '引用是指向该提交的分支或标签名称。只有 Git 为该提交命名了引用时才会显示。'
  },
  'auto.components.right.sidebar.GitHistoryPanel.cf7cad58d2': { zh: '暂无提交' },
  'auto.components.right.sidebar.GitHistoryPanel.d0fb0f4bf2': { zh: '刷新提交记录' },
  'auto.components.right.sidebar.GitHistoryPanel.e5e81e59a6': { zh: '调整提交列表大小' },
  'auto.components.right.sidebar.index.0314901467': { zh: '源代码管理' },
  'auto.components.right.sidebar.index.6306b48afd': { zh: '源代码管理' },
  'auto.components.right.sidebar.index.83a10e3c44': { zh: '检查' },
  'auto.components.right.sidebar.index.9fffaf17c1': { zh: '切换右侧边栏（{{value0}}）' },
  'auto.components.right.sidebar.activity.bar.buttons.1fd284e931': { zh: '更多侧边栏标签页' },
  'auto.components.right.sidebar.ChecksPanel.07871c0589': { zh: '关联另一个 PR' },
  'auto.components.right.sidebar.ChecksPanel.192e686e57': { zh: '在 {{value0}} 上打开' },
  'auto.components.right.sidebar.ChecksPanel.5c88c6db07': { zh: '在 {{value0}} 上打开' },
  'auto.components.right.sidebar.ChecksPanel.7202f4a40a': { zh: '取消关联 PR' },
  'auto.components.right.sidebar.ChecksPanel.fdb27637f2': { zh: '正在发布…' },
  'auto.components.right.sidebar.CreatePullRequestDialog.0c9f9a568c': {
    zh: '支持 Markdown 格式。点击“用 AI 生成”，可根据当前更改自动填写。'
  },
  'auto.components.right.sidebar.CreatePullRequestDialog.7a21f0dae8': {
    zh: '在 {{value0}} 上打开'
  },
  'auto.components.right.sidebar.HostedReviewActions.b25f63edd7': { zh: '未关闭' },
  'auto.components.right.sidebar.checks.panel.content.1abb17aac9': { zh: '更多' },
  'auto.components.right.sidebar.checks.panel.content.2524d1fb83': {
    zh: '完整详情中可查看日志末尾内容。'
  },
  'auto.components.right.sidebar.checks.panel.content.365254cc1b': { zh: '标记为未解决' },
  'auto.components.right.sidebar.checks.panel.content.3916814392': { zh: '落后（基础提交：' },
  'auto.components.right.sidebar.checks.panel.content.49731703ea': { zh: '作业' },
  'auto.components.right.sidebar.checks.panel.content.5341023167': { zh: '检查' },
  'auto.components.right.sidebar.checks.panel.content.5d4ebf9391': {
    zh: '查看详情或启动一轮 AI 修复。'
  },
  'auto.components.right.sidebar.checks.panel.content.60186d8498': { zh: '冲突阻止此操作' },
  'auto.components.right.sidebar.checks.panel.content.679bf2093c': { zh: '复制日志片段' },
  'auto.components.right.sidebar.checks.panel.content.95ad090b01': { zh: '线程' },
  'auto.components.right.sidebar.checks.panel.content.991f50c7e4': { zh: '未配置检查' },
  'auto.components.right.sidebar.checks.panel.content.9ad98f2a17': { zh: '待处理' },
  'auto.components.right.sidebar.checks.panel.content.ae8a04ef17': { zh: '无法获取冲突文件详情' },
  'auto.components.right.sidebar.checks.panel.content.b652f38caf': { zh: '失败的检查' },
  'auto.components.right.sidebar.checks.panel.content.c16762ac8c': {
    zh: '以下检查和评论来自最近一次获取的结果。'
  },
  'auto.components.right.sidebar.checks.panel.content.cdbfda4dec': { zh: '注解' },
  'auto.components.right.sidebar.checks.panel.content.d713f500b2': { zh: '日志片段' },
  'auto.components.right.sidebar.checks.panel.content.df137989b3': { zh: '仅显示前 20 条注解' },
  'auto.components.right.sidebar.checks.panel.content.e15a8b77ef': {
    zh: '此检查没有可直接显示的详情。'
  },
  'auto.components.right.sidebar.checks.panel.content.e4e3af15ee': { zh: '查看完整详情' },
  'auto.components.right.sidebar.checks.panel.content.f2fe8a4e8f': { zh: '注解' },
  'auto.components.right.sidebar.checks.panel.content.fd46a70f1a': { zh: '已启动' },
  'auto.components.right.sidebar.checks.panel.empty.state.5f478ab3d3': { zh: '无法刷新 PR' },
  'auto.components.right.sidebar.checks.panel.empty.state.76e15946a9': {
    zh: '分支有未推送的提交'
  },
  'auto.components.right.sidebar.checks.panel.empty.state.7c299df37b': { zh: '未找到 PR' },
  'auto.components.right.sidebar.checks.panel.empty.state.938b5606a6': { zh: '正在查找 PR' },
  'auto.components.right.sidebar.SourceControl.03d238218c': { zh: '详情' },
  'auto.components.right.sidebar.SourceControl.011f9713fc': { zh: '提交被阻止' },
  'auto.components.right.sidebar.SourceControl.04a5d7239b': {
    zh: '此仓库没有受支持的 Web 远程地址'
  },
  'auto.components.right.sidebar.SourceControl.054ead86b1': { zh: '使用 AI 修复提交失败' },
  'auto.components.right.sidebar.SourceControl.0d0a8359d3': { zh: '提交信息' },
  'auto.components.right.sidebar.SourceControl.11b5dd8e41': { zh: '比较基准：' },
  'auto.components.right.sidebar.SourceControl.1406954883': { zh: '清除所有笔记…' },
  'auto.components.right.sidebar.SourceControl.1f7119f604': { zh: '目标分支' },
  'auto.components.right.sidebar.SourceControl.27a50fe970': { zh: '查看冲突' },
  'auto.components.right.sidebar.SourceControl.2f609a2e7c': { zh: '删除所有未跟踪文件' },
  'auto.components.right.sidebar.SourceControl.2fe2a67580': { zh: '更多笔记操作' },
  'auto.components.right.sidebar.SourceControl.30b8d4f181': { zh: '使用 AI 修复提交失败' },
  'auto.components.right.sidebar.SourceControl.3278b2767b': { zh: '领先' },
  'auto.components.right.sidebar.SourceControl.3eb9b2805e': { zh: '打开 {{value0}} 上的笔记' },
  'auto.components.right.sidebar.SourceControl.461575b9bc': { zh: '使用 AI 生成提交信息' },
  'auto.components.right.sidebar.SourceControl.473f18758e': { zh: '源代码管理 AI 设置' },
  'auto.components.right.sidebar.SourceControl.476b77745b': { zh: '更改比较基准' },
  'auto.components.right.sidebar.SourceControl.493f963029': { zh: '更改比较基准' },
  'auto.components.right.sidebar.SourceControl.4b37ae99b0': {
    zh: '启动默认智能体来修复此次提交失败'
  },
  'auto.components.right.sidebar.SourceControl.574d2f4413': { zh: '清除笔记' },
  'auto.components.right.sidebar.SourceControl.59654650d3': { zh: '清除 {{value0}} 的笔记' },
  'auto.components.right.sidebar.SourceControl.655633c08a': { zh: '已发送' },
  'auto.components.right.sidebar.SourceControl.6b122529d4': { zh: '生成提交信息' },
  'auto.components.right.sidebar.SourceControl.72f2bea3f4': { zh: '展开笔记' },
  'auto.components.right.sidebar.SourceControl.78ce2d37ac': { zh: '推送到派生仓库' },
  'auto.components.right.sidebar.SourceControl.7a09d7f9d2': { zh: '基础分支' },
  'auto.components.right.sidebar.SourceControl.812cb992ee': { zh: '在 {{value0}} 上打开' },
  'auto.components.right.sidebar.SourceControl.8a5ba6a988': { zh: '无法加载提交差异' },
  'auto.components.right.sidebar.SourceControl.8cde1a2fb0': { zh: '暂存' },
  'auto.components.right.sidebar.SourceControl.8d8f5c6c94': { zh: '正在生成提交信息…' },
  'auto.components.right.sidebar.SourceControl.94c42b252e': { zh: 'MD' },
  'auto.components.right.sidebar.SourceControl.9e5ccd00aa': { zh: '无法获取提交失败的上下文' },
  'auto.components.right.sidebar.SourceControl.9febd8ab5f': { zh: 'create_pr' },
  'auto.components.right.sidebar.SourceControl.a9bf7c171a': { zh: '提交失败' },
  'auto.components.right.sidebar.SourceControl.b16b8f0e4b': { zh: 'AI 提交信息' },
  'auto.components.right.sidebar.SourceControl.b656381c18': { zh: '删除笔记' },
  'auto.components.right.sidebar.SourceControl.b94112eb9e': { zh: '提交信息' },
  'auto.components.right.sidebar.SourceControl.c05fe04839': {
    zh: '推送到 {{value0}} 上的派生仓库（非 origin）'
  },
  'auto.components.right.sidebar.SourceControl.c085946bda': { zh: '复制第 {{value0}} 行的笔记' },
  'auto.components.right.sidebar.SourceControl.c321542ee2': { zh: '删除第 {{value0}} 行的笔记' },
  'auto.components.right.sidebar.SourceControl.cc199ccc5f': { zh: '更多提交和远程操作' },
  'auto.components.right.sidebar.SourceControl.createPrIntentConfigureAi': {
    zh: '请添加提交信息或配置源代码管理 AI 设置。'
  },
  'auto.components.right.sidebar.SourceControl.createPrIntentGenerateFailed': {
    zh: '无法生成提交信息。请填写后重试。'
  },
  'auto.components.right.sidebar.SourceControl.createPrIntentPushing': { zh: '正在推送提交…' },
  'auto.components.right.sidebar.SourceControl.d13edef890': { zh: '折叠笔记' },
  'auto.components.right.sidebar.SourceControl.d7492cafce': {
    zh: '无法刷新源代码管理。请重试创建 PR。'
  },
  'auto.components.right.sidebar.SourceControl.d7ae61269b': { zh: '分支上的已提交更改' },
  'auto.components.right.sidebar.SourceControl.dd43c47089': {
    zh: '选择处理此次提交失败的智能体'
  },
  'auto.components.right.sidebar.SourceControl.ddc1fbd690': { zh: '停止生成提交信息' },
  'auto.components.right.sidebar.SourceControl.eae2d051af': { zh: '复制所有笔记' },
  'auto.components.right.sidebar.SourceControl.ec7bfced55': { zh: '选择智能体修复提交失败' },
  'auto.components.right.sidebar.SourceControl.f62ce91ade': { zh: 'origin' },
  'auto.components.right.sidebar.SourceControl.f6cb48b6fe': { zh: '用 AI 解决' },
  'auto.components.right.sidebar.SourceControl.fda060d6ce': {
    zh: '请检查提交信息，然后重试创建 PR。'
  },
  'auto.components.right.sidebar.SourceControlAgentActionDialogForm.c7ff8cef11': {
    zh: '正在检测智能体…'
  },
  'auto.components.right.sidebar.SourceControlAgentActionDialogForm.fe119187bb': {
    zh: '--model sonnet'
  },
  'auto.components.right.sidebar.SourceControlTextGenerationDialogForm.1f6fcfb6cf': {
    zh: '命令模板'
  },
  'auto.components.right.sidebar.SourceControlTextGenerationDialogForm.551ffd111b': {
    zh: '--model sonnet'
  },
  'auto.components.right.sidebar.source.control.ai.commit.failure.launch.4f4e0418a0': {
    zh: '无法构建智能体提示词。'
  },
  'auto.components.right.sidebar.source.control.ai.commit.failure.launch.a8b97d2318': {
    zh: '已启动智能体处理提交失败。'
  },
  'auto.components.right.sidebar.source.control.ai.commit.failure.launch.f2b47026e8': {
    zh: '提交失败提示词为空。请更新源代码管理 AI 设置。'
  },
  'auto.components.right.sidebar.source.control.discard.confirmation.5ddd8cac7f': {
    zh: '放弃所有已暂存的更改？'
  },
  'auto.components.right.sidebar.source.control.dropdown.items.226b85a3a7': { zh: '获取' },
  'auto.components.right.sidebar.source.control.dropdown.items.323bb614aa': { zh: '提交并同步' },
  'auto.components.right.sidebar.source.control.primary.action.16aee3a5c1': { zh: '正在提交…' },
  'auto.components.right.sidebar.source.control.primary.action.390abeab93': { zh: '强制推送' },
  'auto.components.right.sidebar.source.control.primary.action.3d5dccef0b': {
    zh: '没有可提交的更改。PR 已合并。'
  },
  'auto.components.right.sidebar.source.control.primary.action.95550cff15': { zh: '推送' },
  'auto.components.right.sidebar.source.control.primary.action.ab41fb926b': {
    zh: '提交已暂存的更改'
  },
  'auto.components.right.sidebar.source.control.primary.action.acce237921': {
    zh: '没有可提交的更改。此分支没有可发布的更改。'
  },
  'auto.components.right.sidebar.source.control.primary.action.d64292a938': { zh: '拉取' },
  'auto.components.right.sidebar.source.control.primary.action.e61b0d7a3c': {
    zh: '请先检出分支再发布提交。'
  },
  'auto.components.right.sidebar.source.control.primary.action.f01f16d77f': {
    zh: '输入提交信息后提交'
  },
  'auto.components.right.sidebar.source.control.primary.action.fa3bd4f40c': {
    zh: '至少暂存一个文件后再提交'
  },
  'auto.components.rightSidebar.FolderWorkspacePrChecksPanel.reviewChecks': { zh: '查看检查' },

  // Additional key-specific corrections found during full-catalog human review.
  'auto.components.right.sidebar.checks.panel.content.7c1f0a2b11': { zh: '未解决' },

  'auto.components.right.sidebar.GitHistoryPanel.9289ba0cb9': { zh: '什么是 Git 引用？' },

  'auto.components.rightSidebar.FolderWorkspaceWorktreesPanel.unavailable': {
    zh: '只有文件夹工作区才会显示此面板。'
  },

  'auto.components.right.sidebar.source.control.ai.push.failure.launch.f2b47026e8': {
    zh: '推送失败提示词为空。请更新源代码管理 AI 设置。'
  },

  'auto.components.right.sidebar.source.control.ai.recovery.launch.push.empty': {
    zh: '推送失败提示词为空。请更新源代码管理 AI 设置。'
  },

  'auto.components.right.sidebar.source.control.ai.recovery.launch.commit.empty': {
    zh: '提交失败提示词为空。请更新源代码管理 AI 设置。'
  },

  'auto.components.right.sidebar.FileExplorerBackgroundMenu.21fe46ed36': {
    zh: '新建文件'
  },

  'auto.components.right.sidebar.FileExplorerRow.37c875d827': { zh: '新建文件' },

  'auto.components.right.sidebar.FileExplorerToolbar.d95e30fe28': {
    zh: '刷新资源管理器'
  },

  'auto.components.right.sidebar.SourceControlAgentActionDialogForm.1d47db9bf0': {
    zh: '没有已启用的智能体'
  }
}
