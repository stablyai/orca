import { describe, expect, it } from 'vitest'

import { repairTranslatedValue } from './locale-translation-policy.mjs'

describe('locale-translation-policy zh round 5', () => {
  it('fixes brand spacing, hosted review, and Orca Mobile regressions', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.stats.ShareUsageCard.0eb31e79ee',
        enValue: 'Orca IDE',
        localeValue: 'Orca集成开发环境',
        locale: 'zh'
      })
    ).toBe('Orca IDE')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.ShortcutsPane.2a0e8aeccf',
        enValue: 'Orca first',
        localeValue: 'Orca第一',
        locale: 'zh'
      })
    ).toBe('Orca 优先')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.CommitMessageAiPane.2dafc7646e',
        enValue: 'Hosted-review creation defaults',
        localeValue: '托管审阅创建默认值',
        locale: 'zh'
      })
    ).toBe('托管评审创建默认值')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.AccountsPane.3180536c7a',
        enValue: 'Codex Accounts',
        localeValue: 'Codex账户',
        locale: 'zh'
      })
    ).toBe('Codex 账户')
    expect(
      repairTranslatedValue({
        key: 'menu.showMobileButton',
        enValue: 'Show Orca Mobile Button',
        localeValue: '显示 Orca 移动按钮',
        locale: 'zh'
      })
    ).toBe('显示 Orca Mobile 按钮')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.GitPane.e02ea23a32',
        enValue: 'Orca Attribution',
        localeValue: 'Orca归属',
        locale: 'zh'
      })
    ).toBe('Orca 归因')
    expect(
      repairTranslatedValue({
        key: 'auto.hooks.useSettingsNavigationMetadata.ab4b21b58e',
        enValue: 'Branch naming, base refs, attribution, and Git AI Author.',
        localeValue: '分支命名、基本引用、归属和 Git AI 作者。',
        locale: 'zh'
      })
    ).toBe('分支命名、基础引用、归因和 Git AI Author。')
    expect(
      repairTranslatedValue({
        key: 'auto.components.workspace.cleanup.WorkspaceCleanupDialog.1b18868569',
        enValue: 'need review',
        localeValue: '待审阅',
        locale: 'zh'
      })
    ).toBe('待评审')
    expect(
      repairTranslatedValue({
        key: 'auto.components.GitHubItemDialog.ec5c4b3ab2',
        enValue: 'Reopen PR',
        localeValue: '重新开放PR',
        locale: 'zh'
      })
    ).toBe('重新打开 PR')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.integrations.search.a5e5da02f7',
        enValue: 'integration',
        localeValue: '一体化',
        locale: 'zh'
      })
    ).toBe('集成')
  })

  it('keeps Terminal as a product surface term', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.Settings.3de4bbb841',
        enValue: 'Terminal',
        localeValue: '终端',
        locale: 'zh'
      })
    ).toBe('Terminal')
    expect(
      repairTranslatedValue({
        key: 'auto.components.feature.wall.BrowserAnimatedVisual.04096318ab',
        enValue: 'Terminal 1',
        localeValue: '终端 1',
        locale: 'zh'
      })
    ).toBe('Terminal 1')
    expect(
      repairTranslatedValue({
        key: 'auto.components.agent.AgentCombobox.986f946354',
        enValue: 'Blank Terminal',
        localeValue: '空白端子',
        locale: 'zh'
      })
    ).toBe('空白 Terminal')
    expect(
      repairTranslatedValue({
        key: 'auto.components.terminal.pane.TerminalContextMenu.20e565d865',
        enValue: 'Split Terminal Right',
        localeValue: '分体式端子右',
        locale: 'zh'
      })
    ).toBe('向右拆分 Terminal')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.TerminalAppearanceSection.abcb4dd019',
        enValue: 'Terminal Cursor',
        localeValue: '终端Cursor',
        locale: 'zh'
      })
    ).toBe('Terminal Cursor')
    expect(
      repairTranslatedValue({
        key: 'auto.components.terminal.FloatingTerminalPanel.3215fc73e9',
        enValue: 'New Terminal',
        localeValue: '新Terminal',
        locale: 'zh'
      })
    ).toBe('新 Terminal')
  })

  it('keeps workflow terms in English', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.sidebar.SidebarNav.9c95e1ce91',
        enValue: 'Agents',
        localeValue: '代理',
        locale: 'zh'
      })
    ).toBe('Agents')
    expect(
      repairTranslatedValue({
        key: 'auto.components.GitHubItemDialog.28986b3747',
        enValue: 'Started an AI agent for the broken checks.',
        localeValue: '已启动 AI 代理处理失败的检查。',
        locale: 'zh'
      })
    ).toBe('已启动 AI agent 处理失败的检查。')
    expect(
      repairTranslatedValue({
        key: 'auto.components.LinearIssueMarkdownDescriptionEditor.d9c47069ef',
        enValue: 'Markdown',
        localeValue: '降价',
        locale: 'zh'
      })
    ).toBe('Markdown')
    expect(
      repairTranslatedValue({
        key: 'auto.components.TaskPage.7f3f7b4c18',
        enValue: 'Description (optional, markdown)',
        localeValue: '描述（可选，降价）',
        locale: 'zh'
      })
    ).toBe('描述（可选，markdown）')
    expect(
      repairTranslatedValue({
        key: 'auto.components.sidebar.local.base.ref.suggestion.toast.commits',
        enValue: 'commits',
        localeValue: '次提交',
        locale: 'zh'
      })
    ).toBe('commits')
    expect(
      repairTranslatedValue({
        key: 'auto.store.slices.worktrees.d1d78a7baa',
        enValue:
          'Git could not safely delete branch "{{value0}}"{{value1}}, so Orca kept it to avoid losing local commits.',
        localeValue:
          'Git 无法安全删除分支“{{value0}}”{{value1}}，因此 Orca 保留它以避免丢失本地提交。',
        locale: 'zh'
      })
    ).toBe('Git 无法安全删除分支“{{value0}}”{{value1}}，因此 Orca 保留它以避免丢失本地 commits。')
  })

  it('does not confuse proxy copy with Agent terminology', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.GeneralNetworkSettingsSection.f6d76cc8f4',
        enValue: 'Proxy Bypass Rules',
        localeValue: 'Agent绕过规则',
        locale: 'zh'
      })
    ).toBe('代理绕过规则')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.GeneralNetworkSettingsSection.1e214e265a',
        enValue:
          'Leave empty to use system proxy settings and inherited proxy environment variables.',
        localeValue: '留空以使用系统Agent设置和继承的Agent环境变量。',
        locale: 'zh'
      })
    ).toBe('留空以使用系统代理设置和继承的代理环境变量。')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.general.search.91a46caafc',
        enValue: 'no_proxy',
        localeValue: '无Agent',
        locale: 'zh'
      })
    ).toBe('no_proxy')
  })

  it('keeps repo terminology in English', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.workspace.cleanup.WorkspaceCleanupDialog.0b1766738a',
        enValue: 'Repo',
        localeValue: '回购协议',
        locale: 'zh'
      })
    ).toBe('Repo')
    expect(
      repairTranslatedValue({
        key: 'auto.components.sidebar.add.repo.local.start.actions.fb4fc5380e',
        enValue: 'Local project, Git repo, or folder with many repos',
        localeValue: '本地项目、Git 存储库或包含多个存储库的文件夹',
        locale: 'zh'
      })
    ).toBe('本地项目、Git repo 或包含多个 repos 的文件夹')
  })

  it('keeps product, provider, code, and shell tokens untranslated', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.IntegrationsPane.8489c0aa49',
        enValue: 'Bitbucket',
        localeValue: '位桶',
        locale: 'zh'
      })
    ).toBe('Bitbucket')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.integrations.search.50d20817f7',
        enValue: 'bitbucket',
        localeValue: '位桶',
        locale: 'zh'
      })
    ).toBe('Bitbucket')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.MobileNetworkInterfaceSection.1dc87a7fbc',
        enValue: 'Tailscale',
        localeValue: '尾鳞',
        locale: 'zh'
      })
    ).toBe('Tailscale')
    expect(
      repairTranslatedValue({
        key: 'auto.components.tab.bar.TabBar.efb33546ff',
        enValue: 'Git Bash',
        localeValue: 'git 重击',
        locale: 'zh'
      })
    ).toBe('git bash')
    expect(
      repairTranslatedValue({
        key: 'auto.components.tab.bar.TabBar.2148f65e04',
        enValue: 'PowerShell',
        localeValue: '电源外壳',
        locale: 'zh'
      })
    ).toBe('PowerShell')
    expect(
      repairTranslatedValue({
        key: 'auto.components.github.github.rate.limit.display.bb227706a6',
        enValue: 'REST',
        localeValue: '休息',
        locale: 'zh'
      })
    ).toBe('REST')
    expect(
      repairTranslatedValue({
        key: 'auto.components.right.sidebar.GitHistoryGraphSvg.47eff48230',
        enValue: 'HEAD',
        localeValue: '头',
        locale: 'zh'
      })
    ).toBe('HEAD')
    expect(
      repairTranslatedValue({
        key: 'auto.components.editor.RichMarkdownCodeBlock.9e384d48dc',
        enValue: 'Swift',
        localeValue: '迅速',
        locale: 'zh'
      })
    ).toBe('Swift')
    expect(
      repairTranslatedValue({
        key: 'auto.components.editor.RichMarkdownCodeBlock.e72e6b03f4',
        enValue: 'Rust',
        localeValue: '锈',
        locale: 'zh'
      })
    ).toBe('Rust')
  })

  it('normalizes zh product spacing and contextual review abbreviations', () => {
    expect(
      repairTranslatedValue({
        key: 'settings.appearance.statusBar.claudeToggleDescription',
        enValue: 'Show Claude token and cost usage for the active workspace.',
        localeValue: '显示Claude Token 和成本使用情况。',
        locale: 'zh'
      })
    ).toBe('显示 Claude Token 和成本使用情况。')
    expect(
      repairTranslatedValue({
        key: 'auto.components.feature.wall.ComputerUseAnimatedVisual.94787f01f8',
        enValue: 'Claude Code session started',
        localeValue: 'Claude·科德 会话已开始',
        locale: 'zh'
      })
    ).toBe('Claude Code 会话已开始')
    expect(
      repairTranslatedValue({
        key: 'auto.components.GitHubItemDialog.dbe5e2448e',
        enValue: 'Pull request merged',
        localeValue: 'PR已合并',
        locale: 'zh'
      })
    ).toBe('拉取请求已合并')
    expect(
      repairTranslatedValue({
        key: 'auto.components.GitLabItemDialog.9b11cd233f',
        enValue: 'Closed MR !{{value0}}',
        localeValue: '已关闭先生！{{value0}}',
        locale: 'zh'
      })
    ).toBe('已关闭 MR !{{value0}}')
    expect(
      repairTranslatedValue({
        key: 'auto.components.tab.bar.tab.create.menu.options.1baeb07c17',
        enValue: 'ios simulator',
        localeValue: 'ios simulator',
        locale: 'zh'
      })
    ).toBe('iOS 模拟器')
  })
})
