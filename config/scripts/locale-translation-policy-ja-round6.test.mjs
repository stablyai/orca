import { describe, expect, it } from 'vitest'

import { repairTranslatedValue } from './locale-translation-policy.mjs'

function repairJa(key, enValue, localeValue) {
  return repairTranslatedValue({ key, enValue, localeValue, locale: 'ja' })
}

const WORKTREE = 'ワークツリー'
const WORKSPACE = 'ワークスペース'

describe('locale-translation-policy ja round 6', () => {
  it('renders worktree as ワークツリー, with or without hyphenated English', () => {
    expect(
      repairJa(
        'auto.components.sidebar.WorktreeContextMenu.deleteWorktree',
        'Delete Worktree',
        'ワークスペースを削除'
      )
    ).toContain(WORKTREE)
    expect(repairJa(
      'auto.components.settings.WorktreeHooksSection.ff082fe7c6',
      'Worktree hooks',
      'ワークスペース フック'
    )).toContain(WORKTREE)
  })

  it('does not promote a workspace to a worktree', () => {
    const result = repairJa(
      'auto.components.terminal.pane.TerminalSshReconnectOverlay.removeWorkspaceButton',
      'Remove workspace',
      'ワークツリーを削除'
    )
    expect(result).toContain(WORKSPACE)
    expect(result).not.toContain(WORKTREE)
  })

  it('does not demote a worktree to a workspace', () => {
    const result = repairJa(
      'auto.components.sidebar.WorktreeContextMenu.8d9cd19d09',
      'Open Parent Worktree',
      '親ワークスペースを開く'
    )
    expect(result).toContain(WORKTREE)
    expect(result).not.toContain(WORKSPACE)
  })

  it('keeps both terms when the English names both', () => {
    const result = repairJa(
      'auto.components.terminal.pane.terminal.agent.session.fork.38e41edc6e',
      'This workspace cannot be forked into a git worktree.',
      'このワークスペースは git ワークツリーにフォークできません。'
    )
    expect(result).toContain(WORKSPACE)
    expect(result).toContain(WORKTREE)
  })
})
