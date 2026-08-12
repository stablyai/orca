import { describe, expect, it } from 'vitest'

import { repairTranslatedValue, shouldPreserveEnglishValue } from './locale-translation-policy.mjs'

const ja = (enValue, localeValue, key = 'auto.test.relocalization') =>
  repairTranslatedValue({ key, enValue, localeValue, locale: 'ja' })

describe('locale-translation-policy ja relocalization', () => {
  it('heals generic terms the brand revert left in Latin mid-sentence', () => {
    expect(ja('Close terminal?', 'この terminal を閉じますか?')).toBe('このターミナルを閉じますか?')
    expect(ja('New Terminal', '新規 Terminal')).toBe('新規ターミナル')
    expect(ja('Stop the agent?', 'この agent を停止しますか?')).toBe('この Agent を停止しますか?')
    expect(ja('Nothing to commit.', 'commit するものはありません。')).toBe(
      'コミットするものはありません。'
    )
    expect(ja('Open the repo', 'repo を開く')).toBe('リポジトリを開く')
  })

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

  it('keeps commands and identifiers in English so they still run', () => {
    expect(shouldPreserveEnglishValue('pnpm install')).toBe(true)
    expect(shouldPreserveEnglishValue('glab auth login')).toBe(true)
    expect(shouldPreserveEnglishValue("gh pr list --json number -q '.[0].number'")).toBe(true)
    expect(shouldPreserveEnglishValue('--model sonnet')).toBe(true)
    expect(shouldPreserveEnglishValue('localhost, 127.0.0.1, *.internal')).toBe(true)
    expect(shouldPreserveEnglishValue('stale-agent-row-{{value0}}')).toBe(true)
    expect(shouldPreserveEnglishValue('text-foreground')).toBe(true)
    expect(shouldPreserveEnglishValue('{basePrompt}')).toBe(true)
    expect(shouldPreserveEnglishValue('{firstPrompt}')).toBe(true)
    expect(shouldPreserveEnglishValue('{assistantMessage}')).toBe(true)
    expect(shouldPreserveEnglishValue('/pricing')).toBe(true)
    expect(shouldPreserveEnglishValue('/signup')).toBe(true)
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

  it('normalizes Japanese typography and settled terminology', () => {
    expect(ja('Loading…', '読み込み中...')).toBe('読み込み中…')
    expect(ja('Merge conflict', 'マージ紛争')).toBe('マージ競合')
    // Why: MT inserts a Microsoft-style separator space that Japanese compounds do not use.
    expect(ja('Status bar', 'ステータス バー')).toBe('ステータスバー')
    expect(ja('Missing credentials', '資格情報がありません')).toBe('認証情報がありません')
    expect(ja('Unknown', '未知')).toBe('不明')
    expect(ja('Restart the server', 'サーバを再起動')).toBe('サーバーを再起動')
    expect(ja('Open the browser', 'ブラウザーを開く')).toBe('ブラウザを開く')
  })

  it('leaves ranges and token samples out of the ellipsis rule', () => {
    expect(ja('Compare main...HEAD', 'main...HEAD を比較')).toBe('main...HEAD を比較')
  })

  it('spaces the Latin terms the phrase fixes write back in', () => {
    expect(ja('Clear cookies', 'クッキーを消去')).toBe('Cookie を消去')
    expect(ja('Safely fast-forward the branch', 'ブランチを安全に早送りします')).toBe(
      'ブランチを安全に fast-forward します'
    )
  })

  it('uses ホスト for host, and leaves サーバー alone when English says server', () => {
    expect(ja('Host path', 'サーバーパス')).toBe('ホストパス')
    expect(ja('Enter a path that exists on the selected host.', 'ランタイムサーバー上のパス')).toBe(
      'ホスト上のパス'
    )
    // Why: host and server are deliberately distinct wherever the English uses both.
    expect(ja('Save the server host', 'サーバーを保存')).toBe('サーバーを保存')
  })

  it('restores Git vocabulary and brand names the MT localized', () => {
    expect(ja('Branch upstream', 'ブランチの上流')).toBe('ブランチの upstream')
    expect(ja('origin has commits', '起源にコミットがあります')).toBe('origin にコミットがあります')
    expect(ja('Discard all staged changes?', '段階的な変更を破棄しますか?')).toBe(
      'ステージ済みの変更を破棄しますか?'
    )
    expect(ja('Create Hermes automation', 'エルメスオートメーションを作成')).toBe(
      'Hermes オートメーションを作成'
    )
    expect(ja('Delete the worktree', 'worktree を削除')).toBe('ワークツリーを削除')
  })

  it('keeps class strings, refs, and fixture filenames in English', () => {
    for (const value of [
      'size-4 text-muted-foreground',
      'text-amber-700 dark:text-amber-300',
      'origin/main',
      'upstream/main',
      'login.spec.ts',
      'bastion.example.com'
    ]) {
      expect(shouldPreserveEnglishValue(value)).toBe(true)
    }
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
