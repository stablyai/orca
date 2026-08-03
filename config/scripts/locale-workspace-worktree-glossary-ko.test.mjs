import { describe, expect, it } from 'vitest'

import { repairCatalog, repairTranslatedValue } from './locale-translation-policy.mjs'

function repairKo(key, enValue, localeValue) {
  return repairTranslatedValue({ key, enValue, localeValue, locale: 'ko' })
}

// Assert the terminology contract, not the prose around it — copy gets reworded, the mapping
// between an English term and its Korean rendering is what must not drift.
const WORKTREE = '워크트리'
const WORKSPACE = '워크스페이스'
const STRAY_WORKTREE = '작업 트리'

describe('locale-translation-policy ko workspace/worktree glossary', () => {
  it('renders worktree as 워크트리, spaced or not', () => {
    expect(
      repairKo(
        'auto.components.sidebar.WorktreeContextMenu.deleteWorktree',
        'Delete Worktree',
        '작업 트리 삭제'
      )
    ).toBe('워크트리 삭제')
    expect(
      repairKo(
        'auto.components.settings.WorktreeHooksSection.ff082fe7c6',
        'Worktree hooks',
        '작업트리 후크'
      )
    ).toBe('워크트리 후크')
  })

  it('does not promote a workspace to a worktree', () => {
    const result = repairKo(
      'auto.components.terminal.pane.TerminalSshReconnectOverlay.removeWorkspaceButton',
      'Remove workspace',
      '워크트리 제거'
    )
    expect(result).toContain(WORKSPACE)
    expect(result).not.toContain(WORKTREE)
  })

  it('does not demote a worktree to a workspace', () => {
    const result = repairKo(
      'auto.components.sidebar.WorktreeContextMenu.8d9cd19d09',
      'Open Parent Worktree',
      '상위 워크스페이스 열기'
    )
    expect(result).toContain(WORKTREE)
    expect(result).not.toContain(WORKSPACE)
  })

  it('keeps both terms when the English names both', () => {
    const result = repairKo(
      'auto.components.terminal.pane.terminal.agent.session.fork.38e41edc6e',
      'This workspace cannot be forked into a git worktree.',
      '이 워크스페이스는 git 작업 트리로 포크할 수 없습니다.'
    )
    expect(result).toContain(WORKSPACE)
    expect(result).toContain(WORKTREE)
    expect(result).not.toContain(STRAY_WORKTREE)
  })

  it('renders git primary as 주 so 기본 stays reserved for default', () => {
    expect(repairKo('auto.components.sidebar.WorktreeCard.7d517f82e2', 'primary', '기본')).toBe(
      '주'
    )

    const badge = repairKo(
      'auto.components.sidebar.WorktreeCard.0777de5970',
      'Primary worktree (original clone directory)',
      '기본 작업 트리(원래 복제 디렉터리)'
    )
    expect(badge).toContain(`주 ${WORKTREE}`)
    expect(badge).not.toContain('기본')

    const checkout = repairKo(
      'auto.components.settings.WorktreeSymlinksSection.b07ef5a8b6',
      'Paths to materialize from the primary checkout into newly created worktrees.',
      '기본 체크아웃에서 새로 생성된 작업 트리에 배치할 경로입니다.'
    )
    expect(checkout).toContain('주 체크아웃')
    expect(checkout).toContain(WORKTREE)
    expect(checkout).not.toContain('기본')
  })

  it('keeps 기본 for primary outside the git vocabulary', () => {
    expect(
      repairKo(
        'auto.components.settings.DevToolsPane.primaryActionClicked',
        'Primary action clicked',
        '기본 액션 클릭됨'
      )
    ).toBe('기본 액션 클릭됨')
  })

  it('ships the three working-tree strings without a third loanword', () => {
    // These three keys carry key overrides, so this pins the shipped Korean end to end — the
    // guarantee comes from the overrides, not from the phrase rules. The phrase-rule half of the
    // contract is the next test, which uses a key no override matches.
    for (const key of [
      'auto.components.editor.ConflictComponents.da539359b6',
      'auto.components.editor.EditorContent.8b1a605bae',
      'auto.store.slices.editor.dcb521ed29'
    ]) {
      const result = repairKo(
        key,
        'No working-tree file is available to edit for this conflict.',
        '이 충돌에 대해 편집할 수 있는 작업 트리 파일이 없습니다.'
      )
      expect(result).not.toContain(STRAY_WORKTREE)
      expect(result).not.toContain(WORKTREE)
      expect(result).not.toContain(WORKSPACE)
    }
  })

  it('leaves an unmapped working-tree string for a human rather than rewriting it', () => {
    // No key override and no phrase rule matches working-tree, so a newly extracted string
    // surfaces untouched for a human instead of silently acquiring the wrong term.
    const localeValue = '이 파일은 충돌 상태에 있지만 편집할 수 있는 작업 트리 파일이 없습니다.'
    expect(
      repairKo(
        'auto.components.editor.UnmappedConflictKey',
        'No working-tree file here.',
        localeValue
      )
    ).toBe(localeValue)
  })

  it('skips catalog leaves the locale has not been bootstrapped with yet', () => {
    const enCatalog = { a: { translated: 'Delete Worktree', pending: 'Pairing code ready' } }
    const koCatalog = { a: { translated: '작업 트리 삭제' } }
    expect(() => repairCatalog(enCatalog, koCatalog, 'ko')).not.toThrow()
    expect(koCatalog.a.translated).toBe('워크트리 삭제')
    expect('pending' in koCatalog.a).toBe(false)
  })
})
