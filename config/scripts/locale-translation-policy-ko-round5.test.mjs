import { describe, expect, it } from 'vitest'

import { repairTranslatedValue } from './locale-translation-policy.mjs'

describe('locale-translation-policy ko round 5', () => {
  it('fixes Korean round 5 review, integration, and search keyword regressions', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.sidebar.workspace.status.409528031f',
        enValue: 'Review',
        localeValue: '검토',
        locale: 'ko'
      })
    ).toBe('리뷰')
    expect(
      repairTranslatedValue({
        key: 'auto.components.sidebar.workspace.status.6c1efa2cf8',
        enValue: 'In review',
        localeValue: '검토 중',
        locale: 'ko'
      })
    ).toBe('리뷰 중')
    expect(
      repairTranslatedValue({
        key: 'auto.components.TaskPage.524f095d55',
        enValue: 'Needs review',
        localeValue: '검토 필요',
        locale: 'ko'
      })
    ).toBe('리뷰 필요')
    expect(
      repairTranslatedValue({
        key: 'auto.components.onboarding.IntegrationsStep.277f30eb34',
        enValue:
          'Linear, GitLab, Bitbucket, Azure DevOps, Gitea, and Jira live in Settings > Integrations.',
        localeValue:
          'Linear, GitLab, Bitbucket, Azure DevOps, Gitea 및 Jira는 설정 > 통합에 있습니다.',
        locale: 'ko'
      })
    ).toBe('Linear, GitLab, Bitbucket, Azure DevOps, Gitea 및 Jira는 설정 > 연동에 있습니다.')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.general.search.244e3fb4c8',
        enValue: 'Install the Orca skill so agents know to use the Orca CLI.',
        localeValue: '에이전트가 Orca CLI 사용 방법을 알 수 있도록 Orca 기술을 설치합니다.',
        locale: 'ko'
      })
    ).toBe('agents가 Orca CLI를 사용하도록 Orca 스킬을 설치하세요.')
    expect(
      repairTranslatedValue({
        key: 'auto.components.editor.MarkdownPreview.322afab6ff',
        enValue: 'Review notes',
        localeValue: '메모 검토',
        locale: 'ko'
      })
    ).toBe('리뷰 노트')
    expect(
      repairTranslatedValue({
        key: 'auto.components.right.sidebar.source.control.repo.icon.ecf63ec3ef',
        enValue: 'Launch',
        localeValue: '시작하다',
        locale: 'ko'
      })
    ).toBe('실행')
    expect(
      repairTranslatedValue({
        key: 'auto.components.GitHubItemDialog.485609c4f2',
        enValue: 'check #',
        localeValue: '확인하다 #',
        locale: 'ko'
      })
    ).toBe('체크 #')
    expect(
      repairTranslatedValue({
        key: 'auto.lib.automation.templates.maintenance.prompt',
        enValue:
          'Check for stuck work, stale generated files, failing validation, and anything that needs human attention. Report only actionable issues.',
        localeValue:
          '작업 중단, 오래 생성된 파일, 유효성 검사 실패 및 사람의 주의가 필요한 모든 사항을 확인하세요. 실행 가능한 문제만 보고하세요.',
        locale: 'ko'
      })
    ).toBe(
      '작업 중단, 오래 생성된 파일, 유효성 검사 실패 및 사람의 주의가 필요한 모든 사항을 확인하세요. 실행 가능한 이슈만 보고하세요.'
    )
  })

  it('keeps protected workflow terms in English', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.feature.wall.BrowserAnimatedVisual.04096318ab',
        enValue: 'Terminal 1',
        localeValue: '터미널 1',
        locale: 'ko'
      })
    ).toBe('Terminal 1')
    expect(
      repairTranslatedValue({
        key: 'auto.components.skills.SkillsPage.38e0951c3a',
        enValue: 'Agent Skills',
        localeValue: '에이전트 스킬',
        locale: 'ko'
      })
    ).toBe('Agent 스킬')
    expect(
      repairTranslatedValue({
        key: 'auto.components.LinearIssueMarkdownDescriptionEditor.d9c47069ef',
        enValue: 'Markdown',
        localeValue: '가격 인하',
        locale: 'ko'
      })
    ).toBe('Markdown')
    expect(
      repairTranslatedValue({
        key: 'auto.components.workspace.cleanup.WorkspaceCleanupDialog.9623a5107d',
        enValue: 'Unpushed commits',
        localeValue: '푸시되지 않은 커밋',
        locale: 'ko'
      })
    ).toBe('푸시되지 않은 commits')
    expect(
      repairTranslatedValue({
        key: 'auto.components.workspace.cleanup.WorkspaceCleanupDialog.0b1766738a',
        enValue: 'Repo',
        localeValue: '레포',
        locale: 'ko'
      })
    ).toBe('Repo')
    expect(
      repairTranslatedValue({
        key: 'auto.components.sidebar.add.repo.local.start.actions.fb4fc5380e',
        enValue: 'Local project, Git repo, or folder with many repos',
        localeValue: '로컬 프로젝트, Git 저장소 또는 저장소가 많은 폴더',
        locale: 'ko'
      })
    ).toBe('로컬 프로젝트, Git repo 또는 repos가 많은 폴더')
  })
})
