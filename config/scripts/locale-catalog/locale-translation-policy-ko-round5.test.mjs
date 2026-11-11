import { describe, expect, it } from 'vitest'

import { repairTranslatedValue } from './locale-translation-policy.mjs'

describe('locale-translation-policy ko round 5', () => {
  it('re-glues Korean particles after Latin terms without gluing content words', () => {
    // A wrong space before the 에 particle is re-glued onto the Latin term.
    expect(
      repairTranslatedValue({
        key: 'auto.components.StarNagCard.cf82170065',
        enValue: 'Could not star the repo. Make sure',
        localeValue: 'repo 에 스타를 표시할 수 없습니다. 다음을 확인하세요',
        locale: 'ko'
      })
    ).toBe('repo에 스타를 표시할 수 없습니다. 다음을 확인하세요')
    expect(
      repairTranslatedValue({
        key: 'auto.components.github.project.ProjectCell.4b5b871da8',
        enValue: 'No labels in this repo.',
        localeValue: '이 repo 에는 라벨이 없습니다.',
        locale: 'ko'
      })
    ).toBe('이 repo에는 라벨이 없습니다.')
    expect(
      repairTranslatedValue({
        key: 'auto.components.terminal.pane.CloseTerminalDialog.6b9a6975f8',
        enValue:
          'The terminal still has a running process. If you close the terminal, the process will be killed.',
        localeValue:
          'terminal 에는 여전히 실행 중인 프로세스가 있습니다. terminal을 닫으면 프로세스가 종료됩니다.',
        locale: 'ko'
      })
    ).toBe(
      'terminal에는 여전히 실행 중인 프로세스가 있습니다. terminal을 닫으면 프로세스가 종료됩니다.'
    )
    // A correct space before a content word that merely starts with a particle syllable is kept.
    expect(
      repairTranslatedValue({
        key: 'auto.components.JiraIssueWorkspace.76513c7898',
        enValue: 'Close Jira issue preview',
        localeValue: 'Jira 이슈 미리보기 닫기',
        locale: 'ko'
      })
    ).toBe('Jira 이슈 미리보기 닫기')
    expect(
      repairTranslatedValue({
        key: 'auto.components.GitHubItemDialog.3ab6ac0fc8',
        enValue: 'Preview and edit the selected GitHub issue or pull request.',
        localeValue: '선택한 GitHub 이슈 또는 PR을 미리보기하고 편집합니다.',
        locale: 'ko'
      })
    ).toBe('선택한 GitHub 이슈 또는 PR을 미리보기하고 편집합니다.')
  })
})
