// Human-reviewed Simplified Chinese for task and hosted work-item surfaces.
// Why: these strings need key-level context; broad phrase replacement would corrupt code tokens.
export const ZH_MANUAL_WORK_ITEM_KEY_OVERRIDES = {
  // Task, GitHub, GitLab, Linear, and Jira surfaces.
  'auto.components.TaskPage.0506a78337': { zh: '这将更新 GitHub 上的 PR。' },
  'auto.components.TaskPage.0c0de0fc0e': { zh: '无法加载来自' },
  'auto.components.TaskPage.171b7739d8': { zh: 'MR' },
  'auto.components.TaskPage.1742eafc14': { zh: '无项目' },
  'auto.components.TaskPage.2193a99ec1': { zh: '打开与议题关联的工作区' },
  'auto.components.TaskPage.2abe22ef76': {
    zh: '你的 token 会通过系统钥匙串加密，并存储在本机。'
  },
  'auto.components.TaskPage.33fc2bcb30': {
    zh: '使用 Jira Cloud 站点 URL、Atlassian 邮箱和 API token 浏览议题。'
  },
  'auto.components.TaskPage.345b169f1f': { zh: '高' },
  'auto.components.TaskPage.37a82eaaf8': { zh: '已合并' },
  'auto.components.TaskPage.37e7ee311e': { zh: '编号' },
  'auto.components.TaskPage.38139edb52': { zh: 'GitHub' },
  'auto.components.TaskPage.3b11c8e8fc': { zh: 'array' },
  'auto.components.TaskPage.3cb855080f': { zh: '视图' },
  'auto.components.TaskPage.3d93316bb0': { zh: 'PR' },
  'auto.components.TaskPage.5af6f0ae5b': { zh: '选择团队' },
  'auto.components.TaskPage.5d4fd69a6a': { zh: '最近活跃于此 PR' },
  'auto.components.TaskPage.592a55611b': {
    zh: '尝试选择更多团队或刷新；团队筛选条件只适用于当前已获取的议题。'
  },
  'auto.components.TaskPage.5ebff3a0aa': { zh: '无' },
  'auto.components.TaskPage.68df347677': { zh: 'you@example.com' },
  'auto.components.TaskPage.69591944e7': { zh: '低' },
  'auto.components.TaskPage.713179dfdc': { zh: '无优先级' },
  'auto.components.TaskPage.7f3f7b4c18': { zh: '描述（可选，Markdown）' },
  'auto.components.TaskPage.7fd59c18d8': { zh: '中' },
  'auto.components.TaskPage.8a07f21e76': { zh: '健康状况' },
  'auto.components.TaskPage.88f478cdef': { zh: '合并 PR 失败' },
  'auto.components.TaskPage.937b29fa35': { zh: '项' },
  'auto.components.TaskPage.9497f2787c': { zh: '创建工作区' },
  'auto.components.TaskPage.93d5f21fc1': { zh: 'pr' },
  'auto.components.TaskPage.9f2b4c03a6': { zh: '提交到' },
  'auto.components.TaskPage.afc68824ff': { zh: '未找到任何状态' },
  'auto.components.TaskPage.b6329379ca': { zh: '新建工作区' },
  'auto.components.TaskPage.b7bae28b6a': { zh: '已显示' },
  'auto.components.TaskPage.bbec4717ee': { zh: 'mr' },
  'auto.components.TaskPage.c11105dac5': { zh: '新建议题' },
  'auto.components.TaskPage.c8d5bec5f7': { zh: '优先级' },
  'auto.components.TaskPage.cbce2bc9cd': { zh: '无' },
  'auto.components.TaskPage.d3d0998b7d': { zh: '新建 GitHub 议题' },
  'auto.components.TaskPage.d45a910c4a': { zh: '更改 Linear 状态（当前为 {{value0}}）' },
  'auto.components.TaskPage.d6cda23ef1': { zh: '成员' },
  'auto.components.TaskPage.e78ec261ed': { zh: '视图' },
  'auto.components.TaskPage.f373ab1a4f': { zh: '紧急' },
  'auto.components.TaskPage.ff90d0abc7': { zh: '从 {{value0}} 创建工作区' },
  'auto.components.TaskPage.linearEmptyAttributeFilter': {
    zh: '没有议题符合所选筛选条件。请清除筛选条件或尝试其他条件。'
  },
  'auto.components.taskPageEmptyState.noGitLabWorkDescription': {
    zh: '没有 GitLab 工作项符合此筛选条件。'
  },
  'auto.components.taskPageEmptyState.noGitLabWorkTitle': { zh: '没有 GitLab 工作项' },
  'auto.components.GitHubItemDialog.08d072664d': { zh: '作业' },
  'auto.components.GitHubItemDialog.0caac1a18f': { zh: '从 PR 创建工作区' },
  'auto.components.GitHubItemDialog.16c1abe76c': { zh: '标记为已查看' },
  'auto.components.GitHubItemDialog.21860b58d0': { zh: '关闭拉取请求' },
  'auto.components.GitHubItemDialog.28d0d3374f': { zh: '线程' },
  'auto.components.GitHubItemDialog.36182aa57f': { zh: '新建工作区' },
  'auto.components.GitHubItemDialog.3853476a97': { zh: 'GitHub 工作项' },
  'auto.components.GitHubItemDialog.3cd5ae5b7b': { zh: '没有文件变更。' },
  'auto.components.GitHubItemDialog.4812814bc8': { zh: '已启动' },
  'auto.components.GitHubItemDialog.5752c25aff': { zh: '正在发布…' },
  'auto.components.GitHubItemDialog.7d42606f66': { zh: '注解' },
  'auto.components.GitHubItemDialog.829674460a': {
    zh: '由于缺少 PR 提交的 SHA，无法显示差异。'
  },
  'auto.components.GitHubItemDialog.96d8f36798': { zh: '注解' },
  'auto.components.GitHubItemDialog.9f88657c4e': { zh: '拉取请求已关闭' },
  'auto.components.GitHubItemDialog.a35ea5a0f6': { zh: '已启用自动合并' },
  'auto.components.GitHubItemDialog.aba792c8b3': { zh: '合并拉取请求失败' },
  'auto.components.GitHubItemDialog.ba8e329d92': { zh: '取消“已查看”标记' },
  'auto.components.GitHubItemDialog.b6f1b7adbd': {
    zh: '这将在 GitHub 上重新打开拉取请求。'
  },
  'auto.components.GitHubItemDialog.c67de9e2fe': { zh: '未分配负责人' },
  'auto.components.GitHubItemDialog.dc1ca081a8': { zh: '未关闭' },
  'auto.components.GitHubItemDialog.e517b4d641': { zh: '已关闭' },
  'auto.components.GitHubItemDialog.f4b1292569': { zh: '针对这些检查启动默认智能体' },
  'auto.components.PullRequestPage.1a2570e18e': { zh: '新建工作区' },
  'auto.components.PullRequestPage.2b4fdb880c': { zh: '取消“已查看”标记' },
  'auto.components.PullRequestPage.345b68254c': { zh: '线程' },
  'auto.components.PullRequestPage.3d77438c92': {
    zh: '这将在 GitHub 上重新打开拉取请求。'
  },
  'auto.components.PullRequestPage.35a0573f41': { zh: '注解' },
  'auto.components.PullRequestPage.4d18310d55': { zh: '变更文件' },
  'auto.components.PullRequestPage.50b8fb290f': { zh: '标记为已查看' },
  'auto.components.PullRequestPage.71a3c0f9d2': { zh: '创建工作区' },
  'auto.components.PullRequestPage.74660bd80b': {
    zh: '由于缺少 PR 提交的 SHA，无法显示差异。'
  },
  'auto.components.PullRequestPage.76551b1161': { zh: '已启动' },
  'auto.components.PullRequestPage.7720c9c3f5': { zh: '作业' },
  'auto.components.PullRequestPage.7aa3b5f706': { zh: '拉取请求已关闭' },
  'auto.components.PullRequestPage.7b8f6bf6d8': { zh: '未关闭' },
  'auto.components.PullRequestPage.8432d17901': { zh: '注解' },
  'auto.components.PullRequestPage.894cfd884b': { zh: '正在发布…' },
  'auto.components.PullRequestPage.96d013ed28': { zh: '关闭拉取请求' },
  'auto.components.PullRequestPage.a459866967': { zh: '继续使用与 PR 关联的工作区' },
  'auto.components.PullRequestPage.aae645d36d': { zh: '合并拉取请求失败' },
  'auto.components.PullRequestPage.c9e7094a7b': { zh: '继续使用工作区' },
  'auto.components.PullRequestPage.d65f70786e': { zh: '已关闭' },
  'auto.components.PullRequestPage.dd5d9a4f17': { zh: '更新了 {{value0}}' },
  'auto.components.PullRequestPage.filesRetry': { zh: '重试' },
  'auto.components.GitLabItemDialog.007423f585': { zh: '无法获取差异内容。' },
  'auto.components.GitLabItemDialog.02cbe2de44': { zh: '流水线' },
  'auto.components.GitLabItemDialog.21f8dde18a': { zh: '行内评论' },
  'auto.components.GitLabItemDialog.3c0b6ccca7': { zh: 'bug, backend' },
  'auto.components.GitLabItemDialog.60c13320c4': { zh: '已添加行内评论' },
  'auto.components.GitLabItemDialog.7a7204417f': { zh: '行' },
  'auto.components.GitLabItemDialog.808b1ca1ba': { zh: '没有文件变更。' },
  'auto.components.GitLabItemDialog.98718490e4': { zh: '必须填写 MR 标题。' },
  'auto.components.GitLabItemDialog.ceaf7c30c7': { zh: '无法获取此 GitLab 用户的评审人 ID。' },
  'auto.components.GitLabItemDialog.e089f62594': { zh: '已合并 MR !{{value0}}' },
  'auto.components.GitLabItemDialog.f11e3e7675': { zh: '此 MR 没有流水线运行记录。' },
  'auto.components.GitLabItemDialog.f7cb495a12': { zh: '已重试 {{value0}}' },
  'auto.components.GitLabItemDialog.ffdd9a78e1': {
    zh: '缺少 MR 的差异引用，无法添加行内评论。'
  },
  'auto.components.gitlab.gitlab.rate.limit.display.14e144f7a7': { zh: 'GitLab API 配额' },
  'auto.components.gitlab.gitlab.rate.limit.display.3e2c982cfa': { zh: '剩余，距重置' },
  'auto.components.gitlab.gitlab.rate.limit.display.a2d3d1fdde': { zh: 'GitLab API 配额不可用。' },
  'auto.components.gitlab.gitlab.rate.limit.display.a2f68645ac': { zh: '刷新 GitLab API 配额' },
  'auto.components.gitlab.gitlab.rate.limit.display.budget_scope_prefix': { zh: '配额范围' },
  'auto.components.gitlab.gitlab.rate.limit.display.ebc0e8ecf1': {
    zh: '正在加载 GitLab API 配额…'
  },
  'auto.components.github.IssueSourceSelector.30b2c9df91': { zh: 'upstream' },
  'auto.components.github.IssueSourceSelector.51d1608920': { zh: 'origin' },
  'auto.components.github.IssueSourceSelector.643d7e9496': { zh: 'upstream' },
  'auto.components.github.IssueSourceSelector.d6aeb2012b': { zh: '议题来源：' },
  'auto.components.github.PRFilterDropdowns.19bb6f115f': { zh: 'reviewed-by' },
  'auto.components.github.PRFilterSections.3ce4d5e96e': { zh: 'PR' },
  'auto.components.github.PRFilterSections.bd162b7d5a': { zh: '已合并' },
  'auto.components.github.github.rate.limit.display.34973d4695': { zh: 'GitHub API 配额不可用。' },
  'auto.components.github.github.rate.limit.display.5509443543': {
    zh: '正在加载 GitHub API 配额…'
  },
  'auto.components.github.github.rate.limit.display.58c5f88216': { zh: 'GitHub API 配额' },
  'auto.components.github.github.rate.limit.display.6da1858354': { zh: '剩余 · 距重置' },
  'auto.components.github.github.rate.limit.display.budget_scope_prefix': { zh: '配额范围' },
  'auto.components.github.github.rate.limit.display.d12d3d6f33': { zh: '刷新 GitHub API 配额' },
  'auto.components.github.github.rate.limit.display.f42790d150': { zh: '/' },
  'auto.components.github.githubIssueCloseReasons.completed.label': {
    zh: '关闭并标记为已完成'
  },
  'auto.components.github.githubIssueCloseReasons.duplicate.label': {
    zh: '作为重复议题关闭'
  },
  'auto.components.github.githubIssueCloseReasons.notPlanned.label': {
    zh: '关闭并标记为不再处理'
  },
  'auto.components.github.project.ProjectCell.191905e20e': { zh: '当前及后续' },
  'auto.components.github.project.ProjectCell.54cac64427': { zh: '该行缺少仓库 slug。' },
  'auto.components.github.project.ProjectCell.af5d8c912a': { zh: '受限工作项' },
  'auto.components.github.project.ProjectItemSlugDialog.4450efea9c': { zh: 'GitHub 工作项' },
  'auto.components.github.project.ProjectPicker.43a88ae574': { zh: 'BOARD_LAYOUT' },
  'auto.components.github.project.ProjectPicker.5113ecc298': { zh: '通过 URL 或所有者/编号添加' },
  'auto.components.github.project.ProjectPicker.b3044b7a25': { zh: '最近' },
  'auto.components.github.project.ProjectPicker.cafb908f34': { zh: 'TABLE_LAYOUT' },
  'auto.components.github.project.ProjectViewList.4f57d2e0b1': {
    zh: '没有工作项符合此视图的筛选条件。'
  },
  'auto.components.github.project.ProjectViewWrapper.030de75bc5': {
    zh: '此工作项匹配多个所选仓库。'
  },
  'auto.components.github.project.ProjectViewWrapper.1ce21b8cff': {
    zh: '此工作项不在所选仓库中。'
  },
  'auto.components.github.project.ProjectViewWrapper.22df63c393': {
    zh: '当前 token 无法访问子议题数据。'
  },
  'auto.components.github.project.slug.dialog.AssigneesEditor.94a4e6e4fa': { zh: '无' },
  'auto.components.github.project.slug.dialog.LabelsEditor.1a5366b5be': { zh: '无' },
  'auto.components.right.sidebar.gitlab.mr.merge.state.53c6d3b7e9': {
    zh: 'GitLab 显示此 MR 可以合并，但流水线仍在运行'
  },
  'auto.components.right.sidebar.gitlab.mr.merge.state.b41fbc180c': {
    zh: 'GitLab 显示此 MR 可以合并，但部分流水线作业失败'
  },
  'auto.components.LinearIssueMarkdownDescriptionEditor.632096eb1c': { zh: '链接' },
  'auto.components.LinearIssueMarkdownDescriptionEditor.ad1869bd54': { zh: '行内代码' },
  'auto.components.LinearIssueWorkspace.f6c6381593': { zh: '复制提示词' },
  'auto.components.LinearItemDrawer.780ea6ed89': { zh: '未找到任何状态' },
  'auto.components.LinearItemDrawer.b2376d0179': { zh: '正在加载成员' },
  'auto.components.LinearItemDrawer.dd304de85a': { zh: '属性' },
  'auto.components.LinearItemDrawer.fbb90300e2': { zh: '自定义预估' },
  'auto.components.linear.api.key.dialog.7d498f653c': { zh: '个人 API 密钥' },
  'auto.components.linear.api.key.dialog.d56d3629f4': {
    zh: '如需 Orca 显示该账户在此工作区可访问的所有团队，请选择完整访问权限。受限密钥只会显示获准的团队；访问私有团队还要求密钥所有者本身具备权限。'
  },
  'auto.components.linear.api.key.dialog.e3100b36b9': {
    zh: '如果成员 API 密钥被禁用，请联系工作区管理员在工作区 API 设置中启用。'
  },
  'auto.components.linear.priority.icon.c43d3e065b': { zh: '优先级：' },
  'auto.components.linear.project.view.surfaces.06b887d622': { zh: '仅显示前' },
  'auto.components.linear.project.view.surfaces.3ad562bdf4': { zh: '个范围内议题' },
  'auto.components.linear.project.view.surfaces.3be47aed6f': { zh: '优先级' },
  'auto.components.linear.project.view.surfaces.65bda65159': { zh: '成员' },
  'auto.components.linear.project.view.surfaces.7616c986c6': {
    zh: '查看 {{value0}} 的议题'
  },
  'auto.components.linear.project.view.surfaces.8bbecb2510': { zh: '无' },
  'auto.components.linear.project.view.surfaces.98730088a6': {
    zh: '。可通过搜索或在 Linear 中打开来查看完整列表。'
  },
  'auto.components.linear.project.view.surfaces.f059181bd9': { zh: '私有' },
  'auto.components.linear.project.view.surfaces.f5ef24cf46': { zh: '健康状况' },
  'auto.components.linear.scope.selector.405b33c378': { zh: '已获取的团队中没有匹配项。' },
  'auto.components.linear.scope.selector.b3488fad3c': {
    zh: '未获取到团队。可访问范围取决于密钥权限、私有团队成员身份、归档状态和工作区权限，也可能是获取失败。'
  },
  'auto.components.JiraIssueWorkspace.0cc62bd690': { zh: '复制提示词' },
  'auto.components.JiraIssueWorkspace.0f3c07a901': { zh: 'backend, bug' },
  'auto.components.JiraIssueWorkspace.2441be6f9f': { zh: '创建工作区' },
  'auto.components.JiraIssueWorkspace.2a829a2f00': { zh: '优先级' },
  'auto.components.JiraIssueWorkspace.51bed73f88': { zh: '无优先级' },
  'auto.components.JiraIssueWorkspace.693be070d0': { zh: '状态流转' },
  'auto.components.jira.connect.dialog.3d81bf3ab3': { zh: 'API token' },

  // Additional key-specific corrections found during full-catalog human review.
  'auto.components.TaskPage.285bc21dc5': { zh: '请修改或清除查询条件。' },

  'auto.components.GitLabItemDialog.00d0d25825': {
    zh: '文件、行号和评论均为必填项。'
  },

  'auto.components.JiraIssueWorkspace.38839801e8': { zh: '复制议题编号' },

  'auto.components.github.project.GhAuthErrorHelp.891a7d4616': {
    zh: '在当前 shell 中取消设置'
  },

  'auto.components.github.project.GhAuthErrorHelp.fd17b3019f': {
    zh: '永久取消设置（PowerShell）'
  },

  'auto.components.github.project.GhAuthErrorHelp.ae43542893': { zh: '查找设置位置' },

  'auto.components.github.PRFilterDropdowns.b27b7e526c': { zh: '请求评审人' },

  'auto.components.GitHubItemDialog.e463ec935f': { zh: '已请求重新运行检查' },

  'auto.components.GitHubItemDialog.ddafe851e1': { zh: '已请求重新运行检查' },

  'auto.components.PullRequestPage.18f2af42ac': { zh: '已请求重新运行检查' },

  'auto.components.PullRequestPage.5963a6a852': { zh: '已请求重新运行检查' },

  'auto.components.TaskPage.03da966159': {
    zh: '请选择一个项目，以便验证对应 GitLab 主机的登录状态。'
  },

  'auto.components.TaskPage.25ff84769a': { zh: '当前 Linear 范围内没有匹配的议题。' },

  'auto.components.TaskPage.closeAsCompleted': { zh: '关闭并标记为已完成' },

  'auto.components.TaskPage.closeAsNotPlanned': { zh: '关闭并标记为不再处理' },

  'auto.components.TaskPage.closeAsDuplicate': { zh: '作为重复议题关闭' },

  'auto.components.taskPageEmptyState.changeQueryDescription': {
    zh: '请修改或清除查询条件。'
  },

  'auto.components.linear.project.view.surfaces.f4c79cff5f': {
    zh: '请先查看下方的工作区错误信息，再刷新。'
  },

  'auto.components.LinearIssueWorkspace.e1e0a9bca9': { zh: '创建工作区' },

  'auto.components.GitHubItemDialog.307c98e8e3': {
    zh: '在上方再显示 {{value0}} 行'
  },

  'auto.components.GitHubItemDialog.showMoreLinesBelow': {
    zh: '在下方再显示 {{value0}} 行'
  },

  'auto.components.PullRequestPage.e295a78c11': {
    zh: '在上方再显示 {{value0}} 行'
  },

  'auto.components.PullRequestPage.showMoreLinesBelow': {
    zh: '在下方再显示 {{value0}} 行'
  },

  'auto.components.linear.project.view.surfaces.openInLinear': {
    zh: '在 Linear 中打开 {{value0}}'
  },

  'auto.components.TaskPage.67d881244c': { zh: '继续使用与 PR 关联的工作区' },

  'auto.components.GitHubItemDialog.6e43a16435': { zh: '行内' },

  'auto.components.PullRequestPage.e5f4a24f78': { zh: '行内' },

  'auto.components.GitHubItemDialog.4bd1f5b055': { zh: '检查' },

  'auto.components.PullRequestPage.94d95cf1f7': { zh: '检查' },

  'auto.components.TaskPage.a7396b05c6': { zh: '检查' },

  'auto.components.PullRequestPage.5edbe7eefa': { zh: '已启用自动合并' },

  'auto.components.TaskPage.fed317634c': { zh: '已启用自动合并' }
}
