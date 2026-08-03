import { describe, expect, it } from 'vitest'

import { LOCALE_PHRASE_FIXES } from './locale-phrase-fixes.mjs'
import { repairTranslatedValue } from './locale-translation-policy.mjs'
import {
  WORKSPACE_WORKTREE_GLOSSARY,
  applyWorkspaceWorktreeGlossary
} from './locale-workspace-worktree-glossary.mjs'

function whenEnSource(fix) {
  return fix.whenEnMatches ? String(fix.whenEnMatches) : `includes:${fix.whenEnIncludes ?? ''}`
}

describe('locale-workspace-worktree-glossary', () => {
  it('owns cross-term swap rules outside phrase-fix rounds', () => {
    for (const locale of ['ko', 'ja', 'zh']) {
      const glossary = WORKSPACE_WORKTREE_GLOSSARY[locale]
      expect(glossary.length).toBeGreaterThan(0)

      const phraseSignatures = new Set(
        (LOCALE_PHRASE_FIXES[locale] ?? []).map(
          (fix) => `${String(fix.pattern)}→${fix.replacement}|${whenEnSource(fix)}`
        )
      )
      for (const fix of glossary) {
        const signature = `${String(fix.pattern)}→${fix.replacement}|${whenEnSource(fix)}`
        expect(phraseSignatures.has(signature)).toBe(false)
      }
    }
  })

  it('applies standalone without the rest of the repair pipeline', () => {
    expect(applyWorkspaceWorktreeGlossary('Remove workspace', '워크트리 제거', 'ko')).toBe(
      '워크스페이스 제거'
    )
    expect(
      applyWorkspaceWorktreeGlossary('Open Parent Worktree', '親ワークスペースを開く', 'ja')
    ).toContain('ワークツリー')
    expect(applyWorkspaceWorktreeGlossary('primary', '主要', 'zh')).toBe('主')
  })

  it('still wins through repairTranslatedValue after phrase fixes', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.terminal.pane.TerminalSshReconnectOverlay.removeWorkspaceButton',
        enValue: 'Remove workspace',
        localeValue: '워크트리 제거',
        locale: 'ko'
      })
    ).toBe('워크스페이스 제거')
  })
})
