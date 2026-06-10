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
})
