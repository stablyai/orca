// Human-reviewed Simplified Chinese overrides for core settings and search metadata.
// Key-specific entries keep code literals intact and resolve wording that needs call-site context.
export const ZH_MANUAL_SETTINGS_CORE_KEY_OVERRIDES = {
  // Settings navigation and status bar
  'settings.appearance.statusBar.claudeToggleDescription': {
    zh: '显示当前工作区的 Claude 令牌用量和费用。'
  },
  'settings.appearance.statusBar.codexToggleDescription': {
    zh: '显示当前工作区的 Codex 令牌用量和费用。'
  },
  'settings.appearance.statusBar.geminiToggleDescription': {
    zh: '显示当前工作区的 Gemini 令牌用量和费用。'
  },
  'settings.appearance.statusBar.opencodeGoToggleDescription': {
    zh: '显示当前工作区的 OpenCode Go 令牌用量和费用。'
  },
  'settings.appearance.statusBar.portsToggleDescription': {
    zh: '显示工作区的活动端口。点击可查看工作区端口和外部监听地址。'
  },
  'auto.hooks.useSettingsNavigationMetadata.0059bd17f3': { zh: '允许智能体控制电脑上的任意应用。' },
  'auto.hooks.useSettingsNavigationMetadata.09607cb0fe': { zh: 'Git 与源代码管理' },
  'auto.hooks.useSettingsNavigationMetadata.1e761cff2b': { zh: '移动端模拟器' },
  'auto.hooks.useSettingsNavigationMetadata.2cd4ea75da': { zh: '工作区默认设置、应用配置与维护。' },
  'auto.hooks.useSettingsNavigationMetadata.2d0659f6f0': {
    zh: '全局终端、浏览器和 Markdown 标签页。'
  },
  'auto.hooks.useSettingsNavigationMetadata.33a5e1d597': {
    zh: '连接 GitHub、GitLab、Linear 及其他代码托管服务。'
  },
  'auto.hooks.useSettingsNavigationMetadata.3d65d3f1b9': {
    zh: '为 Orca 和编码智能体配置移动端模拟器支持。'
  },
  'auto.hooks.useSettingsNavigationMetadata.4121f7a0a2': {
    zh: '管理智能体、设置默认智能体并自定义命令。'
  },
  'auto.hooks.useSettingsNavigationMetadata.42ae40842f': {
    zh: '保存的终端命令，可全局使用或限定到单个项目。'
  },
  'auto.hooks.useSettingsNavigationMetadata.5235c215ca': {
    zh: '选择要在“任务”页面和侧边栏中显示的任务来源。'
  },
  'auto.hooks.useSettingsNavigationMetadata.5f32ac08f3': { zh: '完成 Orca 核心工作流的入门清单。' },
  'auto.hooks.useSettingsNavigationMetadata.7682607591': {
    zh: '在智能体或终端有事件时发送原生桌面通知。'
  },
  'auto.hooks.useSettingsNavigationMetadata.8ac3de82f5': { zh: '使用设备端模型进行本地语音转写。' },
  'auto.hooks.useSettingsNavigationMetadata.95a1886d94': { zh: '通过手机控制终端和智能体。' },
  'auto.hooks.useSettingsNavigationMetadata.b11a5a48a2': {
    zh: '主题、缩放、应用与终端外观、侧边栏和状态栏。'
  },
  'auto.hooks.useSettingsNavigationMetadata.b351014180': {
    zh: 'Orca 统计，以及 Claude、Codex、OpenCode 的令牌分析和 Grok 订阅用量。'
  },
  'auto.hooks.useSettingsNavigationMetadata.b49abbd2f7': { zh: '智能体' },
  'auto.hooks.useSettingsNavigationMetadata.cd50cec5d7': { zh: '通过 Orca 协调多个编码智能体。' },
  'auto.hooks.useSettingsNavigationMetadata.e338c507c1': { zh: '用于故障排除的底层兼容性设置。' },
  'auto.hooks.useSettingsNavigationMetadata.e815fd01bd': {
    zh: '主页、链接打开方式和会话 Cookie。'
  },
  'auto.hooks.useSettingsNavigationMetadata.f70ac54d38': { zh: 'AI 提供商账户' },

  // Core settings surfaces
  'auto.components.settings.AccountsPane.3d245ef7d9': { zh: 'Codex 报告此登录已失效' },
  'auto.components.settings.AccountsPane.316ca4e610': { zh: '删除 Cookie' },
  'auto.components.settings.AccountsPane.53f7b8c7a2': { zh: '上次刷新：{{value0}}' },
  'auto.components.settings.AccountsPane.589eba1eee': { zh: '需要重新登录' },
  'auto.components.settings.AccountsPane.79418c782a': {
    zh: '在浏览器中打开 platform.minimax.io/console/usage 并登录，然后在 DevTools 的“网络”面板中选择任意 remains 请求，复制 Cookie 请求头。'
  },
  'auto.components.settings.AccountsPane.7ce0e1907c': {
    zh: '）。可在浏览器的 DevTools → 网络 → 任意 opencode.ai 请求 → Cookie 请求头中找到。OpenCode Go 采用 Web 登录，Windows 与 WSL 终端共享此登录状态。'
  },
  'auto.components.settings.AccountsPane.854ebbcc45': {
    zh: 'Orca 将删除此已保存账户的托管 Claude 身份验证。如果它是当前账户，Orca 将回退到系统默认的 Claude 登录。'
  },
  'auto.components.settings.AccountsPane.a7e38affcd': {
    zh: 'Fe26.2**… 令牌或 auth=Fe26.2**… 请求头'
  },
  'auto.components.settings.AccountsPane.b15ce90870': {
    zh: '{{value0}} → {{value1}}。继续旧会话前，请重启正在运行的 Claude 终端。'
  },
  'auto.components.settings.AccountsPane.d0d53b7eb0': {
    zh: '管理 Orca 用于实时获取速率限制信息的 Codex 账户。'
  },
  'auto.components.settings.AccountsPane.e05d0ff737': {
    zh: '使用 {{value0}} 中当前的 Claude 登录。'
  },
  'auto.components.settings.AccountsPane.fcc4093fc1': {
    zh: '使用 {{value0}} 中当前的 Codex 登录。'
  },
  'auto.components.settings.AdvancedNetworkSettingsSection.0adfce9fa7': {
    zh: '支持 http、https、socks、socks4 和 socks5 URL。'
  },
  'auto.components.settings.AdvancedNetworkSettingsSection.3e431564b5': {
    zh: 'localhost, 127.0.0.1, *.internal'
  },
  'auto.components.settings.AdvancedNetworkSettingsSection.d93c7cd531': {
    zh: '配置应用级网络路由。'
  },
  'auto.components.settings.AdvancedPane.8b7a8df299': {
    zh: '用于技术支持和故障排除的底层兼容性方案。'
  },
  'auto.components.settings.AppearancePane.102d6b5f9b': { zh: 'IDE 字体' },
  'auto.components.settings.AppearancePane.5db6ba961f': {
    zh: '在左侧边栏顶部显示 Orca Mobile 按钮。'
  },
  'auto.components.settings.AppearancePane.61d842eca0': {
    zh: '在侧边栏中显示 Orca Mobile 快捷入口。也可随时从工具箱打开。'
  },
  'auto.components.settings.AppearancePane.9868f39007': { zh: '标题栏应用名称' },
  'auto.components.settings.AppearancePane.ca1590d42f': { zh: '应用图标' },
  'auto.components.settings.AppearancePane.leftSidebarAppearance.matchTerminal': { zh: '匹配终端' },
  'auto.components.settings.AppearancePane.leftSidebarAppearance.rowDescription': {
    zh: '让左侧边栏匹配终端、保持默认外观或使用自定义色调。'
  },
  'auto.components.settings.AppearancePane.terminalTitle': { zh: '终端' },
  'auto.components.settings.CommitMessageAiPane.15b60d54b2': {
    zh: '例如：ollama run llama3.1 {prompt}'
  },
  'auto.components.settings.CommitMessageAiPane.25350d670f': { zh: '自定义' },
  'auto.components.settings.CommitMessageAiPane.34d0348e34': { zh: '生成' },
  'auto.components.settings.CommitMessageAiPane.4f722a5f53': {
    zh: '选择“自定义命令”的提交信息、拉取请求和分支名称方案会使用此设置。使用'
  },
  'auto.components.settings.CommitMessageAiPane.8cd2be0948': { zh: '消息' },
  'auto.components.settings.CommitMessageAiPane.d5f0de6309': { zh: '打开“创建 PR”时生成详情' },
  'auto.components.settings.CliSection.8a9b784c60': { zh: '已过期' },
  'auto.components.settings.CliSection.36a6f919ba': {
    zh: '为智能体提供理解 Orca 的工作区、终端和进度工作流。'
  },
  'auto.components.settings.ExperimentalPane.0277901cf7': {
    zh: '在左侧边栏添加“智能体”入口，以线程式工作树动态展示已完成的智能体、阻塞问题、未读状态和工作树创建事件。此功能为实验性，事件模型和界面可能会调整。'
  },
  'auto.components.settings.ExperimentalPane.agentHibernation.copy': {
    zh: '达到设定的空闲时长后，停止已完成的后台智能体终端；再次打开时恢复受支持的会话。智能体休眠会保留由 Orca 启动的智能体的启动选项；手动启动的智能体可能按当前 Orca 默认设置恢复。安全机制仍在调试，因此该功能为实验性。'
  },
  'auto.components.settings.ExperimentalPane.agentHibernation.description': {
    zh: '达到设定的空闲时长后，停止后台智能体终端；再次打开时恢复受支持的会话。'
  },
  'auto.components.settings.ExperimentalPane.agentHibernation.idleMinutesDescription': {
    zh: '已完成的后台智能体需要空闲多少分钟，Orca 才会将其休眠。'
  },
  'auto.components.settings.ExperimentalPane.agentHibernation.title': { zh: '智能体休眠' },
  'auto.components.settings.ExperimentalPane.ec897e8d89': { zh: '终端提醒' },
  'auto.components.settings.ExperimentalPane.f63ea281e3': {
    zh: '以线程形式汇总智能体完成事件和阻塞状态的左侧边栏动态。'
  },
  'auto.components.settings.ExperimentalPane.nativeChat.copy': {
    zh: '添加可从受支持的智能体终端窗格切换的原生聊天视图。对话记录准确性、流式响应和终端体验一致性仍在调试，因此该功能为实验性。'
  },
  'auto.components.settings.GeneralEditorSettingsSection.45c6e85c4d': { zh: '编辑器' },
  'auto.components.settings.GeneralEditorSettingsSection.b492397d34': {
    zh: '默认显示 Git 差异时采用的布局。'
  },
  'auto.components.settings.GeneralEditorSettingsSection.b82f86d7d2': {
    zh: '富文本 Markdown 拼写检查'
  },
  'auto.components.settings.GeneralEditorSettingsSection.f80603d293': {
    zh: '在富文本编辑器中显示本地 Markdown 笔记控件和智能体交接操作。'
  },
  'auto.components.settings.GeneralSupportSection.511782265b': {
    zh: '在 GitHub 上为项目加星以示支持。'
  },
  'auto.components.settings.GeneralSupportSection.5c49f02662': { zh: '已隐藏' },
  'auto.components.settings.GeneralSupportSection.6922c1fa2b': { zh: '在 GitHub 上为 Orca 加星' },
  'auto.components.settings.GeneralUpdateSettingsSection.7173352632': { zh: '空闲' },
  'auto.components.settings.GeneralUpdateSettingsSection.82465b2444': { zh: '可用' },
  'auto.components.settings.GeneralUpdateSettingsSection.90eb7309d7': { zh: '不可用' },
  'auto.components.settings.GeneralUpdateSettingsSection.a0832ccdb1': { zh: '已下载' },
  'auto.components.settings.GitPane.3072428ac7': { zh: 'glab' },
  'auto.components.settings.GitPane.813e15b346': { zh: '自定义' },
  'auto.components.settings.GitPane.b5f534717a': { zh: '共同署名' },
  'auto.components.settings.GrokAccountsSection.75e396bf42': {
    zh: 'Grok 统一计费账户包含的月度用量。'
  },
  'auto.components.settings.GrokAccountsSection.e6dadc1e2b': { zh: '月度用量' },
  'auto.components.settings.IntegrationsPane.15cf990798': { zh: '未通过身份验证' },
  'auto.components.settings.IntegrationsPane.1683acbac4': {
    zh: '连接 Orca 用于拉取请求、合并请求、检查和评审状态的代码托管平台。'
  },
  'auto.components.settings.IntegrationsPane.1fac9b4910': { zh: '{{value0}} · 拉取请求和提交状态' },
  'auto.components.settings.IntegrationsPane.277fc23929': { zh: '{{value0}} · 拉取请求和构建状态' },
  'auto.components.settings.IntegrationsPane.3ba07f933b': {
    zh: '连接议题跟踪服务，让 Orca 浏览任务并在新工作区中自动附上相关上下文。'
  },
  'auto.components.settings.IntegrationsPane.45bf5e6e4b': { zh: '身份验证失败' },
  'auto.components.settings.IntegrationsPane.4972f3c95d': { zh: '已配置' },
  'auto.components.settings.IntegrationsPane.51000487c4': { zh: 'gh auth login' },
  'auto.components.settings.IntegrationsPane.6355fe585e': { zh: '已检测仓库的拉取请求和提交状态' },
  'auto.components.settings.IntegrationsPane.6bd148dcb5': {
    zh: '通过 Gitea REST API 获取拉取请求和提交状态。'
  },
  'auto.components.settings.IntegrationsPane.9707523939': { zh: '拉取请求和构建状态' },
  'auto.components.settings.IntegrationsPane.a3326f6f1b': { zh: 'glab' },
  'auto.components.settings.IntegrationsPane.ae38fc62a8': { zh: '正常' },
  'auto.components.settings.IntegrationsPane.e74de656ce': { zh: 'glab auth login' },
  'auto.components.settings.IntegrationsPane.e7b2dd46f9': { zh: '正在测试…' },
  'auto.components.settings.KagiSessionLinkForm.ff450194cd': { zh: 'Kagi 私密会话链接' },
  'auto.components.settings.ManageSessionKillDialog.87dcafc85c': { zh: '结束此会话？' },
  'auto.components.settings.McpConfigFileRow.845ae248e8': { zh: '有效' },
  'auto.components.settings.McpConfigFileRow.e720c139cd': { zh: '打开' },
  'auto.components.settings.NotificationsPane.4aa5085cd7': { zh: '自定义：' },
  'auto.components.settings.OpenInMenuSetting.c1d817e027': { zh: '已添加' },
  'auto.components.settings.QuickCommandsPane.9b3e338d62': { zh: 'Enter' },
  'auto.components.settings.QuickCommandsPane.8c877dec41': { zh: '全局' },
  'auto.components.settings.RecentTabOrderControl.6e6a3fcc61': { zh: '最近使用' },
  'auto.components.settings.RepositoryHooksSection.2d03a514db': { zh: '本地' },
  'auto.components.settings.RepositoryHooksSection.39da2ae12f': { zh: 'orca.yaml' },
  'auto.components.settings.RepositoryHooksSection.bbbd6e0bc4': { zh: '命令来源与 orca.yaml' },
  'auto.components.settings.RepositoryHooksSection.8dbe6bedf5': { zh: '无效' },
  'auto.components.settings.RepositoryHooksSection.0518758f38': { zh: '两者' },
  'auto.components.settings.RepositoryHooksSection.175daba180': { zh: '示例' },
  'auto.components.settings.RepositoryIconPicker.2d8bd302fa': { zh: '头像' },
  'auto.components.settings.RepositorySourceControlAiActionRows.1cd88d470a': { zh: '自定义' },
  'auto.components.settings.RepositorySourceControlAiCustomCommand.f9941f0caf': {
    zh: '例如：ollama run llama3.1 {prompt}'
  },
  'auto.components.settings.RuntimeEnvironmentsPane.54dee18f5c': { zh: '隐藏表单' },
  'auto.components.settings.RuntimePairingUrlGenerator.13704d635e': {
    zh: '已复制 Web 客户端 URL。'
  },
  'auto.components.settings.RuntimePairingUrlGenerator.6dd594a507': {
    zh: '已生成 Web 客户端 URL。'
  },
  'auto.components.settings.RuntimePairingUrlGenerator.b91e36a986': { zh: 'Web' },
  'auto.components.settings.Settings.e1578cd4bc': { zh: '工作流' },
  'auto.components.settings.Settings.6855b0f77d': { zh: '完成 Orca 并行智能体工作的核心工作流。' },
  'auto.components.settings.SettingsFormControls.cb330ef7f8': { zh: ' / {{value0}}' },
  'auto.components.settings.SourceControlAiActionRecipeDefaults.db9bd75d10': { zh: '参数' },
  'auto.components.settings.SourceControlActionRepoOverrideNote.reviewFirst': { zh: '先查看' },
  'auto.components.settings.SourceControlActionRepoOverrideNote.review': { zh: '查看' },
  'auto.components.settings.SparsePresetSettingsSection.a6fcdd9e3c': { zh: '名称' },
  'auto.components.settings.SparsePresetSettingsSection.68bbcd864a': { zh: '新建' },
  'auto.components.settings.TerminalInteractionSection.567633ff50': {
    zh: '右键点击将剪贴板内容粘贴到终端；按住 Control 点击可打开上下文菜单。'
  },
  'auto.components.settings.TerminalInteractionSection.c64497148a': {
    zh: '右键点击可粘贴剪贴板内容；按住 Control 点击可打开上下文菜单。'
  },
  'auto.components.settings.TerminalAppearanceSection.048aac8a64': { zh: '终端排版' },
  'auto.components.settings.TerminalAppearanceSection.1b79379d4f': {
    zh: '控制非活动窗格的变暗程度和拆分分隔线的粗细。'
  },
  'auto.components.settings.TerminalAppearanceSection.2e5aec3cf6': { zh: '下划线' },
  'auto.components.settings.TerminalAppearanceSection.52854a5608': { zh: '块状' },
  'auto.components.settings.TerminalAppearanceSection.7233d594bf': {
    zh: '为支持连字的字体渲染编程连字（例如 =>、!=、===）。“自动”仅对已知的连字字体启用此功能（Fira Code、JetBrains Mono、Cascadia Code、Iosevka 等）。'
  },
  'auto.components.settings.TerminalAppearanceSection.74736cc9b1': { zh: '闪烁光标' },
  'auto.components.settings.TerminalAppearanceSection.855a76343a': { zh: '从 Ghostty 导入' },
  'auto.components.settings.TerminalAppearanceSection.a408266e67': { zh: '字体系列' },
  'auto.components.settings.TerminalAppearanceSection.abcb4dd019': { zh: '终端光标' },
  'auto.components.settings.TerminalAppearanceSection.b9f1804422': { zh: '光标不透明度' },
  'auto.components.settings.TerminalAppearanceSection.bafc80efbc': { zh: '控制终端的行高倍数。' },
  'auto.components.settings.TerminalAppearanceSection.db270cc9a9': { zh: '光标形状' },
  'auto.components.settings.TerminalAppearanceSection.e070e8aeba': { zh: '竖线' },
  'auto.components.settings.TerminalAppearanceSection.e1a5c25555': { zh: '终端窗格' },
  'auto.components.settings.TerminalAppearanceSection.f27a99978d': { zh: '分隔线粗细' },
  'auto.components.settings.TerminalPane.0a10420e1a': { zh: '将 Option 用作 Alt' },
  'auto.components.settings.TerminalPane.1158f8fd55': { zh: '新标签页' },
  'auto.components.settings.TerminalPane.219aaa59f4': { zh: 'WSL 发行版' },
  'auto.components.settings.TerminalPane.6c6a054a1c': { zh: '在新标签页中运行' },
  'auto.components.settings.TerminalPane.9df53f7c14': { zh: '终端历史记录行数' },
  'auto.components.settings.TerminalPane.ab3a1f9068': { zh: 'wsl.exe' },
  'auto.components.settings.TerminalPane.adbafefe56': { zh: '自定义' },
  'auto.components.settings.TerminalPane.badb1219fc': { zh: '两者' },
  'auto.components.settings.TerminalPane.c1fc9e9444': { zh: 'GPU 加速' },
  'auto.components.settings.TerminalPane.c73d510938': { zh: '右侧' },
  'auto.components.settings.TerminalPane.d78fc4fdef': { zh: '正在加载发行版' },
  'auto.components.settings.TerminalPane.e7aec1fd60': { zh: '左侧' },
  'auto.components.settings.TerminalPane.f61ac77f16': { zh: 'Git Bash' },
  'auto.components.settings.TerminalPane.fe20f79dd1': { zh: 'PowerShell 版本' },
  'auto.components.settings.TerminalPane.scrollSpeed.normalDescription': {
    zh: '滚轮滚动终端历史记录的倍数。'
  },
  'auto.components.settings.TerminalSettingsPreview.d06664e889': { zh: '深色' },
  'auto.components.settings.TerminalWindowSection.0cb4459fb8': { zh: '白色' },
  'auto.components.settings.TerminalWindowSection.1be593d3e8': { zh: 'ANSI 亮色' },
  'auto.components.settings.TerminalWindowSection.292a4c7316': { zh: '蓝色' },
  'auto.components.settings.TerminalWindowSection.3a78f30b50': { zh: '红色' },
  'auto.components.settings.TerminalWindowSection.40c3cfd30a': { zh: '选区背景色' },
  'auto.components.settings.TerminalWindowSection.68e9f07de0': { zh: 'ANSI 常规色' },
  'auto.components.settings.TerminalWindowSection.8b450b5305': { zh: '选区前景色' },
  'auto.components.settings.TerminalWindowSection.8f2092b315': { zh: '绿色' },
  'auto.components.settings.TerminalWindowSection.907131d741': { zh: '正在重启…' },
  'auto.components.settings.TerminalWindowSection.a2d9f095a7': { zh: '光标文字' },
  'auto.components.settings.TerminalWindowSection.adfdee23cb': { zh: '黑色' },
  'auto.components.settings.TerminalWindowSection.b96ba13ed1': { zh: '窗口' },
  'auto.components.settings.TerminalWindowSection.bb516de873': { zh: '黄色' },
  'auto.components.settings.TerminalWindowSection.c9e1fdf42f': { zh: '光标' },
  'auto.components.settings.TerminalWindowSection.cd0700762b': { zh: '光标颜色' },
  'auto.components.settings.TerminalWindowSection.cf37ff69f6': { zh: '基础色' },
  'auto.components.settings.TerminalWindowSection.da64e8f4c1': { zh: '终端背景色' },
  'auto.components.settings.TerminalWindowSection.fb8c6f1967': {
    zh: '粗体文字的颜色。未设置时回退到常规颜色。'
  },
  'auto.components.settings.VoicePane.174da92062': { zh: '按住' },
  'auto.components.settings.VoicePane.1ba81c0ff0': { zh: '推荐' },
  'auto.components.settings.VoicePane.295d84b849': {
    zh: '一次开始，再按一次停止。按住模式：仅在按住'
  },
  'auto.components.settings.VoicePane.366e1b4f36': { zh: '即可在当前聚焦的窗格中听写文本。' },
  'auto.components.settings.VoicePane.7cf715f891': { zh: '时听写。' },
  'auto.components.settings.VoicePane.d504ab05f0': { zh: '流式' },
  'auto.components.settings.VoicePane.fbe5990716': { zh: '选择模型' },
  'auto.components.settings.SshPassphraseDialog.405066423c': { zh: '解锁' },
  'auto.components.settings.WorktreeSymlinksSection.ea06227efa': { zh: '已添加' },
  'auto.components.settings.WslCliRegistration.e2b0ee267f': { zh: '已过期' },

  // Search metadata with literal MT errors
  'auto.components.settings.accounts.search.5b3f18ef4a': { zh: '切换' },
  'auto.components.settings.accounts.search.7e67d7d1b6': { zh: 'wrk' },
  'auto.components.settings.accounts.search.bdbd1e668e': { zh: 'Windows' },
  'auto.components.settings.accounts.search.e02c136ad0': { zh: '身份验证' },
  'auto.components.settings.accounts.search.7118d2f908': { zh: '凭据' },
  'auto.components.settings.accounts.search.042885c07c': { zh: '已过期' },
  'auto.components.settings.agents.search.77c02fa3c3': { zh: 'Windows' },
  'auto.components.settings.appearance.search.00a028f25f': { zh: '用量' },
  'auto.components.settings.appearance.search.0c83659f48': { zh: '快捷键' },
  'auto.components.settings.appearance.search.4ddbde4999': { zh: 'CPU' },
  'auto.components.settings.appearance.search.d18b54ca90': { zh: 'Dock' },
  'auto.components.settings.appearance.search.f4997e0f8a': { zh: '连接' },
  'auto.components.settings.appearance.search.51f957ce39': { zh: '名称' },
  'auto.components.settings.appearance.search.a278406ed5': { zh: '远程' },
  'auto.components.settings.appearance.search.e5bc35d59e': { zh: '窗口' },
  'auto.components.settings.auto.rename.branch.search.a482f6a423': { zh: 'slug' },
  'auto.components.settings.auto.rename.branch.search.f41833025e': { zh: '生成' },
  'auto.components.settings.browser.search.0bb34eacc9': { zh: '查询' },
  'auto.components.settings.browser.search.1c1e097985': { zh: 'Arc' },
  'auto.components.settings.browser.search.1f8153acfb': { zh: 'DuckDuckGo' },
  'auto.components.settings.browser.search.29193a51d5': { zh: 'Cookie' },
  'auto.components.settings.browser.search.0732ebe6fb': { zh: '私密' },
  'auto.components.settings.browser.search.5164c47e31': { zh: '空白' },
  'auto.components.settings.browser.search.3910a41f32': { zh: '身份验证' },
  'auto.components.settings.browser.search.533a253deb': { zh: 'Edge' },
  'auto.components.settings.browser.search.72c58f7792': { zh: 'WebView' },
  'auto.components.settings.browser.search.7539f6336c': { zh: '配置文件' },
  'auto.components.settings.browser.search.75a0d435b7': { zh: 'Chrome' },
  'auto.components.settings.browser.search.90425d313c': { zh: 'Shift' },
  'auto.components.settings.browser.search.ad40e75d13': { zh: 'Bing' },
  'auto.components.settings.browser.search.e1c2a57f07': { zh: 'Kagi' },
  'auto.components.settings.browser.use.search.088e7a9012': { zh: 'Chrome' },
  'auto.components.settings.browser.use.search.2e1b09897b': { zh: 'Edge' },
  'auto.components.settings.browser.use.search.6ea88e5206': { zh: 'npx' },
  'auto.components.settings.browser.use.search.7e0dcb257a': { zh: 'Shell' },
  'auto.components.settings.browser.use.search.96ce3d2de2': { zh: '身份验证' },
  'auto.components.settings.browser.use.search.ab349a2dd0': { zh: 'Arc' },
  'auto.components.settings.browser.use.search.fb8178824f': { zh: 'Cookie' },
  'auto.components.settings.commit.message.ai.search.0f29331fed': { zh: '参数' },
  'auto.components.settings.commit.message.ai.search.8e9cc598d7': { zh: '生成' },
  'auto.components.settings.commit.message.ai.search.93e5210da8': { zh: '消息' },
  'auto.components.settings.computer.use.search.82f01c2d2c': { zh: '无障碍' },
  'auto.components.settings.developer.permissions.search.00e954319e': { zh: 'Whisper' },
  'auto.components.settings.developer.permissions.search.08f8039ca9': { zh: '无障碍' },
  'auto.components.settings.developer.permissions.search.b192432ef0': { zh: '音频' },
  'auto.components.settings.developer.permissions.search.7f145a3984': { zh: '窗口' },
  'auto.components.settings.developer.permissions.search.78a10b826f': { zh: 'Bonjour' },
  'auto.components.settings.developer.permissions.search.f061f08b7b': { zh: 'SoX' },
  'auto.components.settings.experimental.search.8facf10138': { zh: '铃声' },
  'auto.components.settings.experimental.search.9af7a518db': { zh: '角色' },
  'auto.components.settings.experimental.search.4d63251595': {
    zh: '以线程形式汇总智能体完成事件和阻塞状态的左侧边栏动态。'
  },
  'auto.components.settings.floating.workspace.search.2b5efa55c9': { zh: '全局' },
  'auto.components.settings.general.search.2b463f0bf9': { zh: '视图' },
  'auto.components.settings.general.search.9da6c875e5': { zh: 'Dock' },
  'auto.components.settings.general.search.e4fb4516d0': { zh: '加星' },
  'auto.components.settings.general.search.ebf8f056b5': { zh: 'Zed' },
  'auto.components.settings.general.search.6382fe9724': { zh: 'npx' },
  'auto.components.settings.general.search.54ba13831a': { zh: '最近' },
  'auto.components.settings.general.search.ec5049e510': { zh: '嵌套' },
  'auto.components.settings.general.search.f8f0ac213a': { zh: '顺序' },
  'auto.components.settings.general.search.f472e97440': { zh: 'Aider' },
  'auto.components.settings.general.search.fb84767421': { zh: '切换' },
  'auto.components.settings.general.search.fe62b3f09f': { zh: 'Ctrl' },
  'auto.components.settings.git.search.769ddd7f81': { zh: '自定义' },
  'auto.components.settings.git.search.6ee3cfff02': { zh: 'git diff' },
  'auto.components.settings.git.search.8461c908ae': { zh: '共同署名' },
  'auto.components.settings.git.search.ead733645f': { zh: 'glab' },
  'auto.components.settings.jira.integration.card.3df81cb0ac': { zh: '正常' },
  'auto.components.settings.mobile.emulator.search.25d7bfbcd4': { zh: 'UDID' },
  'auto.components.settings.mobile.emulator.search.27397fe8e9': { zh: 'Xcode 命令行工具' },
  'auto.components.settings.mobile.emulator.search.6f728f1456': { zh: '模拟器点击' },
  'auto.components.settings.mobile.emulator.search.7650063d17': { zh: 'simctl' },
  'auto.components.settings.mobile.emulator.search.84e5706975': { zh: 'serve-sim' },
  'auto.components.settings.mobile.emulator.search.ea1f51b980': {
    zh: '检查 Xcode、simctl、serve-sim 和模拟器设备是否已就绪。'
  },
  'auto.components.settings.mobile.emulator.search.ec3c4043fd': { zh: '默认 iPad' },
  'auto.components.settings.mobile.emulator.search.f8b871d655': { zh: '智能体 CLI' },
  'auto.components.settings.mobile.pane.search.126afc5dbd': { zh: '远程' },
  'auto.components.settings.mobile.pane.search.16bff559a0': { zh: 'tailnet' },
  'auto.components.settings.mobile.pane.search.1802188b5d': { zh: 'Wi-Fi' },
  'auto.components.settings.mobile.pane.search.3c1807a81a': { zh: 'QR' },
  'auto.components.settings.mobile.pane.search.5e8fda4d7f': { zh: '已配对' },
  'auto.components.settings.mobile.pane.search.8015fd9523': { zh: '保持' },
  'auto.components.settings.mobile.pane.search.a023683767': { zh: '接口' },
  'auto.components.settings.mobile.pane.search.e518cbd61c': { zh: '配对' },
  'auto.components.settings.mobile.pane.search.fadcbfdd99': { zh: '适配' },
  'auto.components.settings.mobile.pane.search.c690e3ee38': { zh: 'Tailscale' },
  'auto.components.settings.mobile.settings.search.6bfa001752': { zh: 'APK' },
  'auto.components.settings.mobile.settings.search.7e801801ac': { zh: '远程' },
  'auto.components.settings.mobile.settings.search.a7eececc1d': { zh: 'Android' },
  'auto.components.settings.mobile.settings.search.cf2c93b479': { zh: '配对' },
  'auto.components.settings.notifications.search.5f7472d3fb': { zh: '完成' },
  'auto.components.settings.notifications.search.3014ad1b8f': { zh: 'Ding' },
  'auto.components.settings.notifications.search.57e34a31cd': { zh: 'WAV' },
  'auto.components.settings.notifications.search.722face52f': { zh: 'AAC' },
  'auto.components.settings.notifications.search.6e08f78315': { zh: '音频' },
  'auto.components.settings.notifications.search.ae0487f8fd': { zh: '铃声' },
  'auto.components.settings.notifications.search.a4c3b29a3c': { zh: '已聚焦' },
  'auto.components.settings.notifications.search.adbc3a0fcf': { zh: '原生' },
  'auto.components.settings.notifications.search.d58b64dddf': { zh: '音量' },
  'auto.components.settings.notifications.search.ef86a782cc': { zh: 'Bong' },
  'auto.components.settings.notifications.search.fa60d8e4ab': { zh: '抑制' },
  'auto.components.settings.orchestration.search.08c65b12a2': { zh: '示例' },
  'auto.components.settings.orchestration.search.21c28ccdf7': { zh: '协调智能体' },
  'auto.components.settings.orchestration.search.741dfc03fa': { zh: '工作进程' },
  'auto.components.settings.orchestration.search.eee028ae14': { zh: '调度' },
  'auto.components.settings.orchestration.search.f5d39af41e': { zh: '子智能体' },
  'auto.components.settings.privacy.search.2b5a5c312f': { zh: 'PostHog' },
  'auto.components.settings.privacy.search.79c319948b': { zh: '用量' },
  'auto.components.settings.privacy.search.b021b9cb81': { zh: '匿名' },
  'auto.components.settings.quick.commands.search.236d4cfac8': { zh: '快捷' },
  'auto.components.settings.quick.commands.search.8bf43c2dad': { zh: '全局' },
  'auto.components.settings.quick.commands.search.b86c727100': { zh: 'npm' },
  'auto.components.settings.quick.commands.search.b949a7c0a0': { zh: 'pnpm' },
  'auto.components.settings.quick.commands.search.d07d130849': { zh: '快捷键' },
  'auto.components.settings.repository.search.0432d2fb7c': { zh: '本地' },
  'auto.components.settings.repository.search.1d90a6cfbb': { zh: '两者' },
  'auto.components.settings.repository.search.4c17787d7b': { zh: '归档' },
  'auto.components.settings.repository.search.4f3c0230c2': { zh: '稀疏' },
  'auto.components.settings.repository.search.603c68b68c': { zh: 'orca.yaml' },
  'auto.components.settings.repository.search.58d8bca414': { zh: '相对' },
  'auto.components.settings.repository.search.aa42616e3d': { zh: '检出' },
  'auto.components.settings.repository.search.ec70364df2': { zh: '工作流' },
  'auto.components.settings.runtime.environments.search.5cd7dca3b8': { zh: '远程' },
  'auto.components.settings.runtime.environments.search.d760866285': { zh: '客户端' },
  'auto.components.settings.shortcuts.search.7f1b38f59a': { zh: 'TUI' },
  'auto.components.settings.shortcuts.search.ca6a0c2df7': { zh: '快捷键' },
  'auto.components.settings.shortcuts.search.f1adebbe8c': { zh: 'Shell' },
  'auto.components.settings.ssh.search.237b391f7c': { zh: '连接' },
  'auto.components.settings.ssh.search.d41f296f64': { zh: 'ping' },
  'auto.components.settings.ssh.search.d4bcd497c7': { zh: '远程' },
  'auto.components.settings.ssh.search.00d1fda01a': { zh: '新建' },
  'auto.components.settings.tasks.search.604d8e4089': { zh: 'Atlassian' },
  'auto.components.settings.tasks.search.44083ae418': { zh: '显示' },
  'auto.components.settings.terminal.clipboard.search.d106f44fb4': { zh: '远程' },
  'auto.components.settings.terminal.clipboard.search.e87c6d776d': { zh: '自动' },
  'auto.components.settings.terminal.clipboard.search.5ffcd13c90': { zh: 'tmux' },
  'auto.components.settings.terminal.search.0838b3717b': { zh: '窗口' },
  'auto.components.settings.terminal.search.11fd3fbcf2': { zh: 'ANSI' },
  'auto.components.settings.terminal.search.18ce996647': { zh: '垂直' },
  'auto.components.settings.terminal.search.20ce287cc6': { zh: '字重' },
  'auto.components.settings.terminal.search.25f606d9e5': { zh: '闪烁' },
  'auto.components.settings.terminal.search.54a9b3725b': { zh: '水平' },
  'auto.components.settings.terminal.search.6c2f9f05c8': { zh: '毛玻璃' },
  'auto.components.settings.terminal.search.6cddc858ba': { zh: 'WebGL' },
  'auto.components.settings.terminal.search.7db59c4738': { zh: 'alpha' },
  'auto.components.settings.terminal.search.88561b3499': { zh: '冻结' },
  'auto.components.settings.terminal.search.9f2dda133c': { zh: 'PTY' },
  'auto.components.settings.terminal.search.a979df0083': { zh: '从 Ghostty 导入' },
  'auto.components.settings.terminal.search.b3b94cfcb5': { zh: '国际' },
  'auto.components.settings.terminal.search.c4427dc5ff': { zh: 'Alt' },
  'auto.components.settings.terminal.search.fd6c24313d': { zh: '新建' },
  'auto.components.settings.terminal.search.fae142a354': { zh: 'readline' },
  'auto.components.settings.terminal.windows.search.28ff08ed35': { zh: 'Windows' },
  'auto.components.settings.terminal.windows.search.1f402b3651': { zh: 'WSL 发行版' },
  'auto.components.settings.terminal.windows.search.2b4a340ce0': { zh: '发行版' },
  'auto.components.settings.terminal.windows.search.4ee2579c32': { zh: 'Ubuntu' },
  'auto.components.settings.terminal.windows.search.591912177b': { zh: 'Git Bash' },
  'auto.components.settings.terminal.windows.search.6cd20b9e64': { zh: 'cmd' },
  'auto.components.settings.terminal.windows.search.fc564eadaf': { zh: 'Debian' },
  'auto.components.settings.voice.pane.search.10d45a9fce': { zh: 'STT' },
  'auto.components.settings.voice.pane.search.3d8b853963': { zh: '语音' },
  'auto.components.settings.voice.pane.search.064a9bd94a': { zh: '按住' }
}
