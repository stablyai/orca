# Japanese (ja) UI Glossary and Style

Catalog: `src/renderer/src/i18n/locales/ja.json`. Missing keys fall back to English at runtime.

## Voice

- Translate the meaning of the whole phrase, not word by word. If a reader has to guess the English source to understand the Japanese, rewrite it.
- Sentences use です/ます: `ファイルを保存できませんでした。`, `有効にすると、終了時にセッションを保存します。`
- Do not address the user as `あなた`. Leave the subject out.
- Write what the user sees or does, not a literal English verb: `API トークンで Bitbucket Cloud アカウントを連携します。`, not `Bitbucket Cloud アカウントを API トークンに接続します。`. Avoid passives with an agent such as `〜によって〜された`.
- Buttons, menu items and commands drop `する` from サ変 verbs and use the dictionary form for other verbs: `保存`, `削除`, `再試行`, `開く`, `閉じる`. Icon tooltips add the object: `ターミナルを閉じる`.
- Titles, headings and tabs are noun phrases: `ワークツリーの削除`. Checkbox and switch labels keep the source's noun or verb form: `自動保存`, `行番号を表示する`.
- Setting descriptions say what happens: `有効にすると、新しいターミナルを右側に開きます。`
- Failures: `〜できませんでした。` in sentences, `〜に失敗` in short labels.
- Confirmations are questions: `このワークツリーを削除しますか？`
- Labels have no final `。`. Use `…`, not `...`. Use full-width `、。「」（）？！` in Japanese text, and quote UI names with `「」`. Keep backticks and code quoting as in the source.
- Put a half-width space between Japanese and Latin letters, digits or placeholders: `Git リポジトリ`, `{{count}} 個のファイル`. No space inside katakana compounds (`ステータスバー`) or next to full-width punctuation.
- Katakana words from `-er`, `-or`, `-ar` end with `ー`: `ブラウザー`, `コンピューター`, `サーバー`, `フォルダー`, `エディター`, `プロバイダー`, `エミュレーター`. Other words drop it when the katakana, counting `ー`, would be four or more characters: `リポジトリ`, `ディレクトリ`, `メモリ`. Established spellings are exceptions: `ポリシー`, `ワークフロー`, `コンパイラ`, `フォーマッタ`, `スケジューラ`.
- Use kanji from the 常用漢字表 with standard okurigana (`行う`, `表す`). Write `こと`, `とき` and `ください` in hiragana.
- Counters: `件` for records (commits, changes, comments), `個` for objects (files, folders), `回` for times. Japanese uses only the `_other` plural form.

## Terms

Keep product names and acronyms as written (Orca, Claude Code, Codex, GitHub, Git, SSH, WSL, CLI, PR, MCP). Write other developer terms in katakana or Japanese unless noted below.

| English                            | Japanese                                   | Note                                                       |
| ---------------------------------- | ------------------------------------------ | ---------------------------------------------------------- |
| agent / subagent                   | エージェント / サブエージェント            | Do not keep `Agent` in English.                            |
| worktree                           | ワークツリー                               | Distinct from workspace.                                   |
| workspace                          | ワークスペース                             |                                                            |
| repository / repo                  | リポジトリ                                 | Also for `repo`.                                           |
| branch / base branch               | ブランチ / ベースブランチ                  |                                                            |
| commit                             | コミット; verb `コミットする`              |                                                            |
| pull request / PR                  | プルリクエスト / PR                        | Follow the source: `PR` stays `PR`.                        |
| issue                              | Issue                                      | A general problem is `問題`.                               |
| merge / rebase / cherry-pick       | マージ / リベース / チェリーピック         |                                                            |
| push / pull / fetch                | プッシュ / プル / フェッチ                 |                                                            |
| checkout / stash                   | チェックアウト / スタッシュ                |                                                            |
| stage / staged / discard           | ステージ / ステージ済み / 破棄             |                                                            |
| diff / conflict                    | 差分 / 競合                                |                                                            |
| source control                     | ソース管理                                 |                                                            |
| review / code review               | レビュー / コードレビュー                  | `review` in the sense of "look over" is `確認`.            |
| check (CI) / label / comment       | チェック / ラベル / コメント               | A CI check is not `確認`.                                  |
| session / thread / chat            | セッション / スレッド / チャット           |                                                            |
| prompt / context                   | プロンプト / コンテキスト                  |                                                            |
| skill / plugin / hook              | スキル / プラグイン / フック               |                                                            |
| automation / task                  | オートメーション / タスク                  | Do not use `自動化` for the Orca feature.                  |
| sandbox                            | サンドボックス                             |                                                            |
| approve / approval policy          | 承認 / 承認ポリシー                        |                                                            |
| permission / allow                 | 権限 / 許可                                |                                                            |
| usage / usage limit                | 使用量 / 使用量の上限                      | A page that shows usage is `使用状況`.                     |
| rate limit / quota                 | レート制限 / クォータ                      |                                                            |
| token (LLM or auth)                | トークン                                   |                                                            |
| model / provider                   | モデル / プロバイダー                      |                                                            |
| terminal / shell                   | ターミナル / シェル                        |                                                            |
| pane / panel                       | ペイン / パネル                            | Keep the two terms distinct.                               |
| tab / sidebar / status bar         | タブ / サイドバー / ステータスバー         | The keyboard key stays `Tab`.                              |
| editor / browser / command palette | エディター / ブラウザー / コマンドパレット |                                                            |
| file / folder / directory          | ファイル / フォルダー / ディレクトリ       |                                                            |
| project / environment              | プロジェクト / 環境                        |                                                            |
| host / remote / server / SSH host  | ホスト / リモート / サーバー / SSH ホスト  |                                                            |
| port forwarding                    | ポート転送                                 |                                                            |
| settings / default                 | 設定 / デフォルト                          |                                                            |
| enable / disable                   | 有効にする / 無効にする                    |                                                            |
| shortcut / keybinding              | ショートカット / キーバインド              |                                                            |
| sign in / sign out                 | サインイン / サインアウト                  |                                                            |
| account / credential               | アカウント / 認証情報                      |                                                            |
| notification / clipboard           | 通知 / クリップボード                      |                                                            |
| delete / remove                    | 削除                                       | When nothing is destroyed, say from where: `一覧から削除`. |
| pin / unread / archive             | ピン留め / 未読 / アーカイブ               |                                                            |
| dictation                          | 音声入力                                   |                                                            |
| run / launch                       | 実行 / 起動                                | An automation run is `実行`. Starting an app is `起動`.    |

Do not translate placeholders (`{{value0}}`), markup, commands, slash commands, paths, environment variables, attribute names, code examples or keyboard keys. Labels from another product's UI use that product's own Japanese label when it has one.
