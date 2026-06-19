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
    ).toBe('失敗したチェックに対して AI agent を開始しました。')
    expect(
      repairTranslatedValue({
        key: 'auto.hooks.useSettingsNavigationMetadata.95a1886d94',
        enValue: 'Control terminals and agents from your phone.',
        localeValue: '電話機からターミナルとエージェントを制御します。',
        locale: 'ja'
      })
    ).toBe('スマートフォンから terminals と agents を操作')
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
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.CliSection.068552b191',
        enValue: 'Removing…',
        localeValue: '풀이…',
        locale: 'ko'
      })
    ).toBe('제거 중…')
    expect(
      repairTranslatedValue({
        key: 'auto.components.status.bar.SshStatusSegment.63a2b965f6',
        enValue: 'pulling',
        localeValue: '풀 중',
        locale: 'ko'
      })
    ).toBe('가져오는 중')
    expect(
      repairTranslatedValue({
        key: 'auto.components.TaskPage.be8cf68d9f',
        enValue: 'view issues',
        localeValue: '문제 보기',
        locale: 'ko'
      })
    ).toBe('이슈 보기')
    expect(
      repairTranslatedValue({
        key: 'auto.components.GitHubItemDialog.8c45901789',
        enValue: 'Request reviewer {{value0}}',
        localeValue: '요청 검토자 {{value0}}',
        locale: 'ko'
      })
    ).toBe('리뷰어 요청 {{value0}}')
    expect(
      repairTranslatedValue({
        key: 'auto.components.feature.wall.ReviewPRViewAnimatedVisual.25f6838e43',
        enValue: 'lint',
        localeValue: '보풀',
        locale: 'ko'
      })
    ).toBe('lint')
    expect(
      repairTranslatedValue({
        key: 'auto.components.GitLabItemDialog.4168eb2c51',
        enValue: 'Resolve',
        localeValue: '해결하다',
        locale: 'ko'
      })
    ).toBe('해결')
    expect(
      repairTranslatedValue({
        key: 'auto.components.GitHubItemDialog.934add88b6',
        enValue: 'Reviewer',
        localeValue: '검토자',
        locale: 'ko'
      })
    ).toBe('리뷰어')
    expect(
      repairTranslatedValue({
        key: 'auto.components.skills.SkillsPage.f43ad6edf3',
        enValue: 'Skills',
        localeValue: '기술',
        locale: 'ko'
      })
    ).toBe('스킬')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.integrations.search.581844769a',
        enValue: 'mr',
        localeValue: '~ 씨',
        locale: 'ko'
      })
    ).toBe('MR')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.integrations.search.e1263dd748',
        enValue: 'jira',
        localeValue: '지라',
        locale: 'ko'
      })
    ).toBe('Jira')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.integrations.search.aab86d64e5',
        enValue: 'Gitea Integration',
        localeValue: '지테아 통합',
        locale: 'ko'
      })
    ).toBe('Gitea 연동')
    expect(
      repairTranslatedValue({
        key: 'auto.hooks.useSettingsNavigationMetadata.2b043783ef',
        enValue: 'Integrations',
        localeValue: '통합',
        locale: 'ko'
      })
    ).toBe('연동')
    expect(
      repairTranslatedValue({
        key: 'auto.components.GitHubItemDialog.e52bed9264',
        enValue: 'No checks reported yet',
        localeValue: '아직 보고된 검사가 없습니다.',
        locale: 'ko'
      })
    ).toBe('아직 보고된 체크가 없습니다.')
    expect(
      repairTranslatedValue({
        key: 'auto.components.right.sidebar.source.control.primary.action.7aad2c0240',
        enValue: 'Hosted review operation in progress…',
        localeValue: '호스팅 검토 작업 진행 중…',
        locale: 'ko'
      })
    ).toBe('호스팅 PR 작업 진행 중…')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.integrations.search.933deaf732',
        enValue: 'oauth',
        localeValue: '맹세하다',
        locale: 'ko'
      })
    ).toBe('OAuth')
  })

  it('fixes Chinese detected-state and skill terminology regressions', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.sidebar.SidebarNav.e518f544b1',
        enValue: 'No agents detected',
        localeValue: '未已检测代理',
        locale: 'zh'
      })
    ).toBe('未检测到 agents')
    expect(
      repairTranslatedValue({
        key: 'auto.components.skills.SkillsPage.38e0951c3a',
        enValue: 'Agent Skills',
        localeValue: '代理技巧',
        locale: 'zh'
      })
    ).toBe('Agent 技能')
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
    expect(
      repairTranslatedValue({
        key: 'auto.components.GitHubItemDialog.3ab6ac0fc8',
        enValue: 'Preview and edit the selected GitHub issue or pull request.',
        localeValue: '预览并编辑选定的 GitHub 问题或拉取请求。',
        locale: 'zh'
      })
    ).toBe('预览并编辑选定的 GitHub 议题或拉取请求。')
    expect(
      repairTranslatedValue({
        key: 'auto.components.LinearIssueWorkspace.0190b760c1',
        enValue: 'Open on Linear',
        localeValue: 'Linear打开',
        locale: 'zh'
      })
    ).toBe('在 Linear 中打开')
    expect(
      repairTranslatedValue({
        key: 'auto.components.TaskPage.d0e3c8f933',
        enValue: 'No matching GitHub work',
        localeValue: '没有匹配的 GitHub 作品',
        locale: 'zh'
      })
    ).toBe('没有匹配的 GitHub 工作项')
    expect(
      repairTranslatedValue({
        key: 'auto.hooks.useSettingsNavigationMetadata.4a728cd56b',
        enValue: 'New features that are still taking shape. Give them a try.',
        localeValue: '仍在形成的新特征。尝试一下。',
        locale: 'zh'
      })
    ).toBe('仍在形成的新功能。尝试一下。')
  })

  it('fixes Japanese integration, merge, and search keyword regressions', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.integrations.search.f16e41cc72',
        enValue: 'GitHub Integration',
        localeValue: 'GitHubの統合',
        locale: 'ja'
      })
    ).toBe('GitHub 連携')
    expect(
      repairTranslatedValue({
        key: 'auto.components.GitLabItemDialog.e089f62594',
        enValue: 'Merged MR !{{value0}}',
        localeValue: 'MR を統合しました !{{value0}}',
        locale: 'ja'
      })
    ).toBe('MR をマージしました !{{value0}}')
    expect(
      repairTranslatedValue({
        key: 'auto.components.right.sidebar.source.control.primary.action.3d5dccef0b',
        enValue: 'Nothing to commit. PR is already merged.',
        localeValue: 'コミットするものは何もありません。 PR はすでに統合されています。',
        locale: 'ja'
      })
    ).toBe('commit するものはありません。PR はすでにマージされています。')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.integrations.search.581844769a',
        enValue: 'mr',
        localeValue: '氏',
        locale: 'ja'
      })
    ).toBe('MR')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.integrations.search.e1263dd748',
        enValue: 'jira',
        localeValue: 'ジラ',
        locale: 'ja'
      })
    ).toBe('Jira')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.terminal.advanced.search.b7c2cee442',
        enValue: 'experimental',
        localeValue: '実験的機能な',
        locale: 'ja'
      })
    ).toBe('実験的機能')
    expect(
      repairTranslatedValue({
        key: 'auto.components.TaskPage.ef21405c6d',
        enValue: 'Jira issue',
        localeValue: 'Jira の問題',
        locale: 'ja'
      })
    ).toBe('Jira Issue')
    expect(
      repairTranslatedValue({
        key: 'auto.components.mobile.MobileHero.668016be7a',
        enValue: 'on your computer and phone.',
        localeValue: 'コンピューターと携帯電話で。',
        locale: 'ja'
      })
    ).toBe('コンピューターとスマートフォンで。')
    expect(
      repairTranslatedValue({
        key: 'auto.components.GitHubItemDialog.3ab6ac0fc8',
        enValue: 'Preview and edit the selected GitHub issue or pull request.',
        localeValue: '選択した GitHub の課題またはプル リクエストをプレビューおよび編集します。',
        locale: 'ja'
      })
    ).toBe('選択した GitHub Issue または PR をプレビュー・編集します。')
    expect(
      repairTranslatedValue({
        key: 'auto.components.GitHubItemDialog.a2495e4784',
        enValue: 'Pull request',
        localeValue: 'プルリクエスト',
        locale: 'ja'
      })
    ).toBe('PR')
    expect(
      repairTranslatedValue({
        key: 'auto.components.TaskPage.be8cf68d9f',
        enValue: 'view issues',
        localeValue: '問題を表示する',
        locale: 'ja'
      })
    ).toBe('Issue を表示')
    expect(
      repairTranslatedValue({
        key: 'auto.components.editor.EditorContent.e4b074749d',
        enValue: 'Front Matter',
        localeValue: '前の問題',
        locale: 'ja'
      })
    ).toBe('フロントマター')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.IntegrationsPane.c0c8575e05',
        enValue: 'Install the GitHub CLI to enable pull requests, issues, and checks.',
        localeValue:
          'GitHub CLI をインストールして、プル リクエスト、発行、チェックを有効にします。',
        locale: 'ja'
      })
    ).toBe('GitHub CLI をインストールして PR、Issue、チェックを有効にします。')
    expect(
      repairTranslatedValue({
        key: 'auto.components.mobile.MobilePage.e17393c6a3',
        enValue: 'Phone preview',
        localeValue: '電話プレビュー',
        locale: 'ja'
      })
    ).toBe('スマートフォンプレビュー')
    expect(
      repairTranslatedValue({
        key: 'auto.components.GitHubItemDialog.8c45901789',
        enValue: 'Request reviewer {{value0}}',
        localeValue: 'レビュアー {{value0}} をリクエスト',
        locale: 'ja'
      })
    ).toBe('レビュアーをリクエスト {{value0}}')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.appearance.search.5e5b8878bf',
        enValue: 'phone',
        localeValue: '電話',
        locale: 'ja'
      })
    ).toBe('スマートフォン')
  })

  it('fixes Chinese round 4 phone, review, PR, and status chip regressions', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.appearance.search.5e5b8878bf',
        enValue: 'phone',
        localeValue: '电话',
        locale: 'zh'
      })
    ).toBe('手机')
    expect(
      repairTranslatedValue({
        key: 'auto.components.mobile.slides.TerminalSlide.985373052e',
        enValue: 'Switch to phone mode',
        localeValue: '切换到电话模式',
        locale: 'zh'
      })
    ).toBe('切换到手机模式')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.GitPane.b559bf9899',
        enValue: 'e.g. feature',
        localeValue: '例如特征',
        locale: 'zh'
      })
    ).toBe('例如 feature')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.terminal.search.d5e6c7fab1',
        enValue: 'font features',
        localeValue: '字体特征',
        locale: 'zh'
      })
    ).toBe('字体特性')
    expect(
      repairTranslatedValue({
        key: 'auto.components.GitHubItemDialog.934add88b6',
        enValue: 'Reviewer',
        localeValue: '审稿人',
        locale: 'zh'
      })
    ).toBe('评审人')
    expect(
      repairTranslatedValue({
        key: 'auto.components.GitHubItemDialog.a341343303',
        enValue: 'Review comment added.',
        localeValue: '添加了评论评论。',
        locale: 'zh'
      })
    ).toBe('已添加评审评论。')
    expect(
      repairTranslatedValue({
        key: 'auto.components.GitHubItemDialog.6e43a16435',
        enValue: 'Inline',
        localeValue: '排队',
        locale: 'zh'
      })
    ).toBe('内联')
    expect(
      repairTranslatedValue({
        key: 'auto.components.github.pr.merge.state.bf5e4c6c92',
        enValue: 'Blocked',
        localeValue: '被阻止',
        locale: 'zh'
      })
    ).toBe('已阻塞')
    expect(
      repairTranslatedValue({
        key: 'auto.components.sidebar.workspace.status.6c1efa2cf8',
        enValue: 'In review',
        localeValue: '审核中',
        locale: 'zh'
      })
    ).toBe('评审中')
    expect(
      repairTranslatedValue({
        key: 'auto.components.sidebar.workspace.status.2c19d1db33',
        enValue: 'Play',
        localeValue: '玩',
        locale: 'zh'
      })
    ).toBe('Play')
    expect(
      repairTranslatedValue({
        key: 'auto.components.right.sidebar.SourceControlAgentActionDialogForm.1bc0bdbb5e',
        enValue: 'Launch:',
        localeValue: '发射：',
        locale: 'zh'
      })
    ).toBe('启动：')
    expect(
      repairTranslatedValue({
        key: 'auto.components.UpdateCard.actionBadge',
        enValue: 'Action',
        localeValue: '行动',
        locale: 'zh'
      })
    ).toBe('操作')
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
