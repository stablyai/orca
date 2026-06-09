import { describe, expect, it } from 'vitest'

import { repairTranslatedValue, shouldPreserveEnglishValue } from './locale-translation-policy.mjs'

describe('locale-translation-policy', () => {
  it('keeps agent catalog labels in English', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.lib.agent.catalog.760bc6883d',
        enValue: 'Codex',
        localeValue: '사본',
        locale: 'ko'
      })
    ).toBe('Codex')
  })

  it('does not break Copy identifier when fixing Codex', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.example',
        enValue: 'Copy identifier',
        localeValue: '사본 식별자',
        locale: 'ko'
      })
    ).toBe('사본 식별자')
  })

  it('fixes Dismiss homograph in Korean', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.store.slices.worktrees.889487d8bb',
        enValue: 'Dismiss',
        localeValue: '해고하다',
        locale: 'ko'
      })
    ).toBe('닫기')
  })

  it('fixes Gemini zodiac mistranslation in Chinese catalog', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.lib.agent.catalog.12e6baa4f7',
        enValue: 'Gemini',
        localeValue: '双子座',
        locale: 'zh'
      })
    ).toBe('Gemini')
  })

  it('preserves orca URL scheme in Chinese', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.web.WebConnect.27393856e4',
        enValue: 'orca://pair?code=...',
        localeValue: '虎鲸://pair?code=...',
        locale: 'zh'
      })
    ).toBe('orca://pair?code=...')
  })

  it('skips machine translation for standalone brands', () => {
    expect(shouldPreserveEnglishValue('Codex')).toBe(true)
    expect(shouldPreserveEnglishValue('Codex', 'auto.stats.StatsPane.7d26110cea')).toBe(true)
    expect(shouldPreserveEnglishValue('Show Codex usage')).toBe(false)
  })

  it('fixes high-visibility homograph mistranslations', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.AgentsPane.c9b33eb5c0',
        enValue: 'Refreshing…',
        localeValue: '爽やか…',
        locale: 'ja'
      })
    ).toBe('更新中…')
    expect(
      repairTranslatedValue({
        key: 'auto.components.sidebar.workspace.status.28986b3747',
        enValue: 'Started an AI agent for the broken checks.',
        localeValue: '壊れた小切手に対して AI エージェントを開始しました。',
        locale: 'ja'
      })
    ).toBe('失敗したチェックに対して AI エージェントを開始しました。')
    expect(
      repairTranslatedValue({
        key: 'auto.hooks.useSettingsNavigationMetadata.95a1886d94',
        enValue: 'Control terminals and agents from your phone.',
        localeValue: '電話機からターミナルとエージェントを制御します。',
        locale: 'ja'
      })
    ).toBe('スマートフォンからターミナルとエージェントを操作')
    expect(
      repairTranslatedValue({
        key: 'auto.components.GitHubItemDialog.934add88b6',
        enValue: 'Reviewer',
        localeValue: '査読者',
        locale: 'ja'
      })
    ).toBe('レビュアー')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.AgentsPane.92033495ff',
        enValue: 'Auto',
        localeValue: '汽车',
        locale: 'zh'
      })
    ).toBe('自动')
    expect(
      repairTranslatedValue({
        key: 'menu.reportCrash',
        enValue: 'Report Crash...',
        localeValue: '충돌 신고...',
        locale: 'ko'
      })
    ).toBe('크래시 신고...')
    expect(
      repairTranslatedValue({
        key: 'auto.App.722d03aa62',
        enValue: 'The crash report dialog hit an error.',
        localeValue: '충돌 보고서 대화 상자에 오류가 발생했습니다.',
        locale: 'ko'
      })
    ).toBe('크래시 보고서 대화 상자에 오류가 발생했습니다.')
    expect(
      repairTranslatedValue({
        key: 'auto.components.dashboard.DashboardAgentRow.912e136cd9',
        enValue: 'Send',
        localeValue: '보내다',
        locale: 'ko'
      })
    ).toBe('보내기')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.orchestration.search.ca54c69806',
        enValue: 'DAG',
        localeValue: '가리비',
        locale: 'ko'
      })
    ).toBe('DAG')
  })

  it('fixes Chinese detected-state and skill terminology regressions', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.sidebar.SidebarNav.e518f544b1',
        enValue: 'No agents detected',
        localeValue: '未已检测代理',
        locale: 'zh'
      })
    ).toBe('未检测到代理')
    expect(
      repairTranslatedValue({
        key: 'auto.components.skills.SkillsPage.38e0951c3a',
        enValue: 'Agent Skills',
        localeValue: '代理技巧',
        locale: 'zh'
      })
    ).toBe('代理技能')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.appearance.search.9ae151b26b',
        enValue: 'linear',
        localeValue: '线性',
        locale: 'zh'
      })
    ).toBe('Linear')
    expect(
      repairTranslatedValue({
        key: 'auto.components.JiraIssueWorkspace.ef21405c6d',
        enValue: 'Jira issue',
        localeValue: '吉拉问题',
        locale: 'zh'
      })
    ).toBe('Jira 议题')
    expect(
      repairTranslatedValue({
        key: 'auto.components.GitHubItemDialog.dbe5e2448e',
        enValue: 'Pull request merged',
        localeValue: '合并请求请求',
        locale: 'zh'
      })
    ).toBe('拉取请求已合并')
  })

  it('applies search keyword overrides for settings search synonyms', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.appearance.search.262fe1d24f',
        enValue: 'dark',
        localeValue: '어두운',
        locale: 'ko'
      })
    ).toBe('다크')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.appearance.search.24094af355',
        enValue: 'font',
        localeValue: '세례반',
        locale: 'ko'
      })
    ).toBe('폰트')
  })
})
