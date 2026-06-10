import { describe, expect, it } from 'vitest'

import { repairTranslatedValue } from './locale-translation-policy.mjs'

describe('locale-translation-policy ja round 5', () => {
  it('fixes inline, launch, action, MR, and status chip regressions', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.GitHubItemDialog.6e43a16435',
        enValue: 'Inline',
        localeValue: '列をなして',
        locale: 'ja'
      })
    ).toBe('インライン')
    expect(
      repairTranslatedValue({
        key: 'auto.components.repo.repo.icon.ecf63ec3ef',
        enValue: 'Launch',
        localeValue: '打ち上げ',
        locale: 'ja'
      })
    ).toBe('起動')
    expect(
      repairTranslatedValue({
        key: 'auto.components.sidebar.workspace.status.2c19d1db33',
        enValue: 'Play',
        localeValue: '遊ぶ',
        locale: 'ja'
      })
    ).toBe('Play')
    expect(
      repairTranslatedValue({
        key: 'auto.components.TaskPage.8396825a14',
        enValue: 'Action',
        localeValue: 'アクション',
        locale: 'ja'
      })
    ).toBe('操作')
    expect(
      repairTranslatedValue({
        key: 'auto.components.TaskPage.456b8512da',
        enValue: 'MergeRequest',
        localeValue: 'マージリクエスト',
        locale: 'ja'
      })
    ).toBe('MR')
    expect(
      repairTranslatedValue({
        key: 'auto.components.github.PRFilterDropdowns.7f1ba66c3e',
        enValue: 'Reviewed by',
        localeValue: 'レビュー者',
        locale: 'ja'
      })
    ).toBe('レビュアー')
    expect(
      repairTranslatedValue({
        key: 'auto.components.sidebar.workspace.status.caebe3c10f',
        enValue: 'Conductor Review',
        localeValue: '指揮者のレビュー',
        locale: 'ja'
      })
    ).toBe('Conductor レビュー')
    expect(
      repairTranslatedValue({
        key: 'auto.components.github.pr.merge.state.bf5e4c6c92',
        enValue: 'Blocked',
        localeValue: 'ブロック',
        locale: 'ja'
      })
    ).toBe('ブロック中')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.IntegrationsPane.027440e1cb',
        enValue: 'Merge requests, issues, todos, and pipelines via the',
        localeValue: 'リクエスト、イシュー、ToDo、パイプラインをマージします。',
        locale: 'ja'
      })
    ).toBe('MR、イシュー、ToDo、パイプラインは')
    expect(
      repairTranslatedValue({
        key: 'auto.components.GitLabItemDialog.98718490e4',
        enValue: 'MR title is required.',
        localeValue: 'MRの肩書きは必須です。',
        locale: 'ja'
      })
    ).toBe('MR タイトルは必須です。')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.terminal.search.d5e6c7fab1',
        enValue: 'font features',
        localeValue: 'フォントの特徴',
        locale: 'ja'
      })
    ).toBe('フォント特性')
    expect(
      repairTranslatedValue({
        key: 'auto.components.GitHubItemDialog.f05d237049',
        enValue: 'Add a project first',
        localeValue: 'まずプロジェクトを追加してください',
        locale: 'ja'
      })
    ).toBe('まずプロジェクトを追加')
  })
})
