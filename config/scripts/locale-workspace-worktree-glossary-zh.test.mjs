import { describe, expect, it } from 'vitest'

import { repairTranslatedValue } from './locale-translation-policy.mjs'

function repairZh(key, enValue, localeValue) {
  return repairTranslatedValue({ key, enValue, localeValue, locale: 'zh' })
}

const WORKTREE = '工作树'
const WORKSPACE = '工作区'

describe('locale-translation-policy zh workspace/worktree glossary', () => {
  it('renders worktree as 工作树, with or without hyphenated English', () => {
    expect(
      repairZh(
        'auto.components.sidebar.WorktreeContextMenu.deleteWorktree',
        'Delete Worktree',
        '删除工作区'
      )
    ).toBe(`删除${WORKTREE}`)
    expect(
      repairZh(
        'auto.components.settings.WorktreeHooksSection.ff082fe7c6',
        'Worktree hooks',
        '工作区钩子'
      )
    ).toBe(`${WORKTREE}钩子`)
  })

  it('does not promote a workspace to a worktree', () => {
    const result = repairZh(
      'auto.components.terminal.pane.TerminalSshReconnectOverlay.removeWorkspaceButton',
      'Remove workspace',
      '删除工作树'
    )
    expect(result).toContain(WORKSPACE)
    expect(result).not.toContain(WORKTREE)
  })

  it('does not demote a worktree to a workspace', () => {
    const result = repairZh(
      'auto.components.sidebar.WorktreeContextMenu.8d9cd19d09',
      'Open Parent Worktree',
      '打开父工作区'
    )
    expect(result).toContain(WORKTREE)
    expect(result).not.toContain(WORKSPACE)
  })

  it('keeps both terms when the English names both', () => {
    const result = repairZh(
      'auto.components.terminal.pane.terminal.agent.session.fork.38e41edc6e',
      'This workspace cannot be forked into a git worktree.',
      '此工作区无法分叉到 git 工作树。'
    )
    expect(result).toContain(WORKSPACE)
    expect(result).toContain(WORKTREE)
  })

  it('fixes bare primary badge from 主要 to 主', () => {
    expect(repairZh('auto.components.WorktreeJumpPalette.739bda980c', 'primary', '主要')).toBe('主')
    expect(repairZh('auto.components.sidebar.WorktreeCard.7d517f82e2', 'primary', '主要')).toBe(
      '主'
    )
  })

  it('leaves 主工作树 untouched for compound primary-worktree strings', () => {
    const result = repairZh(
      'auto.components.sidebar.WorktreeCard.0777de5970',
      'Primary worktree (original clone directory)',
      '主工作树（原始克隆目录）'
    )
    expect(result).toContain('主工作树')
  })
})
