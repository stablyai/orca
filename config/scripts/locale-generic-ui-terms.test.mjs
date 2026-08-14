import { describe, expect, it } from 'vitest'

import { LOCALIZABLE_GENERIC_TERMS } from './locale-generic-ui-terms.mjs'
import { NEVER_TRANSLATE_VALUES, repairTranslatedValue } from './locale-translation-policy.mjs'

// Why: #12113 — repair-locale-catalog rewrote ~2000 translated values back to English because
// generic UI words (agent, terminal, commit, repo, Continue) were treated as brands. These pin
// the boundary: generic words stay translated, real brand names stay Latin.
describe('locale generic UI terms', () => {
  it('keeps a translated generic term when the whole value is that term', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.AppearancePane.terminalTitle',
        enValue: 'Terminal',
        localeValue: '터미널',
        locale: 'ko'
      })
    ).toBe('터미널')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.QuickCommandsPane.4ccc63da87',
        enValue: 'Agent',
        localeValue: '에이전트',
        locale: 'ko'
      })
    ).toBe('에이전트')
    expect(
      repairTranslatedValue({
        key: 'auto.components.mobile.MobileHero.a8fb43cf1c',
        enValue: 'Continue',
        localeValue: '继续',
        locale: 'zh'
      })
    ).toBe('继续')
  })

  it('keeps a translated generic term inside a sentence', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.EditorFontSection.matchTerminal',
        enValue: 'Match terminal font',
        localeValue: '터미널 글꼴과 동일',
        locale: 'ko'
      })
    ).toBe('터미널 글꼴과 동일')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.ExperimentalPane.agentDashboard.toggleLabel',
        enValue: 'Toggle Agent Dashboard',
        localeValue: '에이전트 대시보드 전환',
        locale: 'ko'
      })
    ).toBe('에이전트 대시보드 전환')
    expect(
      repairTranslatedValue({
        key: 'components.agentSessionContinuation.dialogTitle',
        enValue: 'Continue in New Session',
        localeValue: '新しいセッションで続ける',
        locale: 'ja'
      })
      // 新しい → 新規 is an unrelated phrase fix; 続ける is what must survive.
    ).toBe('新規セッションで続ける')
  })

  it('still reverts real brand names that machine translation localized', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.stats.StatsPane.7d26110cea',
        enValue: 'Codex',
        localeValue: '사본',
        locale: 'ko'
      })
    ).toBe('Codex')
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
        key: 'auto.components.settings.NetworkPane.tailscale',
        enValue: 'Connect over Tailscale',
        localeValue: '通过尾鳞连接',
        locale: 'zh'
      })
    ).toBe('通过 Tailscale 连接')
  })

  it('still reverts nonsense renderings of a generic term', () => {
    // 端子 is an electrical connector, 回购 a repurchase agreement, Comprometerse "to pledge".
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
        key: 'auto.components.right.sidebar.source.control.primary.action.ed93b4f14f',
        enValue: 'Commit',
        localeValue: 'Comprometerse',
        locale: 'es'
      })
    ).toBe('Commit')
    expect(
      repairTranslatedValue({
        key: 'auto.components.LinearIssueMarkdownDescriptionEditor.d9c47069ef',
        enValue: 'Markdown',
        localeValue: '가격 인하',
        locale: 'ko'
      })
    ).toBe('Markdown')
  })

  it('does not cut a valid word that contains a nonsense rendering', () => {
    // 终端子进程 is "terminal sub-process" — 端子 sits inside 终端 + 子.
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.AdvancedNetworkSettingsSection.823e0f15b1',
        enValue: 'Proxy URL for Orca network requests and local terminal subprocesses.',
        localeValue: '用于 Orca 网络请求和本地终端子进程的代理 URL。',
        locale: 'zh'
      })
    ).toBe('用于 Orca 网络请求和本地终端子进程的代理 URL。')
  })

  it('still fills in a translation when the catalog holds English', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.feature.wall.BrowserAnimatedVisual.04096318ab',
        enValue: 'Terminal 1',
        localeValue: 'Terminal 1',
        locale: 'ko'
      })
    ).toBe('터미널 1')
    expect(
      repairTranslatedValue({
        key: 'auto.store.slices.worktrees.889487d8bb',
        enValue: 'Dismiss',
        localeValue: '해고하다',
        locale: 'ko'
      })
    ).toBe('닫기')
  })

  it('keeps agent catalog product names in English by key, not by word', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.lib.agent.catalog.9e2a9bb87b',
        enValue: 'Continue',
        localeValue: '继续',
        locale: 'zh'
      })
    ).toBe('Continue')
    expect(
      repairTranslatedValue({
        key: 'auto.lib.agent.catalog.760bc6883d',
        enValue: 'Codex',
        localeValue: '사본',
        locale: 'ko'
      })
    ).toBe('Codex')
  })

  it('does not list a generic term as never-translatable', () => {
    const pinned = [...LOCALIZABLE_GENERIC_TERMS].filter((term) => NEVER_TRANSLATE_VALUES.has(term))
    expect(pinned).toEqual([])
  })
})
