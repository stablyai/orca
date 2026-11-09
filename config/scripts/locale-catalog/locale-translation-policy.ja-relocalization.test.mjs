import { describe, expect, it } from 'vitest'

import { repairTranslatedValue, shouldPreserveEnglishValue } from './locale-translation-policy.mjs'

const ja = (enValue, localeValue, key = 'auto.test.relocalization') =>
  repairTranslatedValue({ key, enValue, localeValue, locale: 'ja' })

describe('locale-translation-policy ja relocalization', () => {
  it('leaves the second word of a two-word command in Latin', () => {
    expect(ja('a commit hook or git commit fails', 'コミットフックまたは git commit が失敗')).toBe(
      'コミットフックまたは git commit が失敗'
    )
    expect(ja('Run orca terminal', 'orca terminal を実行')).toBe('orca terminal を実行')
    expect(ja('Install with pnpm install', 'pnpm install でインストール')).toBe(
      'pnpm install でインストール'
    )
  })

  it('leaves identifiers, flags, filenames, and Latin-only labels alone', () => {
    expect(ja('Pass --agent to select one.', '--agent を渡して選択します。')).toBe(
      '--agent を渡して選択します。'
    )
    expect(ja('Edit agents.md', 'agents.md を編集')).toBe('agents.md を編集')
    expect(ja('Agent SDK settings', 'Agent SDK の設定')).toBe('Agent SDK の設定')
    expect(ja('Agent SDK settings', 'この Agent SDK の設定')).toBe('この Agent SDK の設定')
    expect(ja('Run git commit -m', 'git commit -m を実行')).toBe('git commit -m を実行')
  })

  it('repairs translated code examples back to executable values', () => {
    expect(ja('--model sonnet', '--モデルソネット')).toBe('--model sonnet')
    expect(
      ja("gh pr list --json number -q '.[0].number'", "gh pr list --json 番号 -q '.[0].number'")
    ).toBe("gh pr list --json number -q '.[0].number'")
    expect(ja('{basePrompt}', '{ベースプロンプト}')).toBe('{basePrompt}')
    expect(ja('/pricing', '/価格設定')).toBe('/pricing')
  })

  it('keeps style blocks in English because a translated selector breaks the view', () => {
    expect(shouldPreserveEnglishValue('.pp-card[data-card="starter"] .pp-cta')).toBe(true)
    expect(shouldPreserveEnglishValue('@keyframes browser-flash { to { opacity: 1; } }')).toBe(true)
    expect(shouldPreserveEnglishValue('.card { background: var(--card); }')).toBe(true)
    // Why: the declaration requirement is what keeps prose containing braces translatable.
    expect(shouldPreserveEnglishValue('e.g. {{value0}}')).toBe(false)
  })

  it('leaves ranges and token samples out of the ellipsis rule', () => {
    expect(ja('Compare main...HEAD', 'main...HEAD を比較')).toBe('main...HEAD を比較')
  })

  it('preserves a selector that has no declaration block', () => {
    for (const value of [
      'div.pricing-grid > div.card.starter:nth-of-type(1) > a.cta',
      '.pp-cta',
      '#dialog',
      '.pp-card[data-card="starter"] .pp-cta',
      'button.primary',
      'a:hover',
      'input[type="text"]',
      'localhost:3000'
    ]) {
      expect(shouldPreserveEnglishValue(value)).toBe(true)
    }
    // Why: two ordinary sentences carry two periods, which must not read as selector joins.
    for (const value of [
      'Open Settings > Git and try again.',
      'Show live workspace ports. Click it for workspace-scoped ports and external listeners.',
      'orca.yaml + local',
      '.gitignore',
      'Status:',
      'Done.',
      '#{{value0}}'
    ]) {
      expect(shouldPreserveEnglishValue(value)).toBe(false)
    }
  })
})
