import { JA_UNIFIED_VALUES } from './locale-ja-unified-values.mjs'

// Japanese value overrides from high-visibility UI audit rounds 1–4.
// Why: keep locale-value-overrides.mjs under max-lines while preserving exact-match repairs.
const JA_AUDIT_OVERRIDES = {
  'Retry loading presets': 'プリセットの読み込みを再試行',
  'Retry Download': 'ダウンロードを再試行',
  'Enter a reviewer': 'レビュアーを入力',
  'Choose folder': 'フォルダーを選択',
  'Choose pet': 'ペットを選択',
  'Choose a sound': 'サウンドを選択',
  'Pick your default agent': 'デフォルトの Agent を選択',
  'Complete {{artifact_url}}': '{{artifact_url}} を完了',
  'Control terminals and agents from your phone.':
    'スマートフォンからターミナルと Agent を操作します。',
  'Add reviewer': 'レビュアーを追加',
  Reviewer: 'レビュアー',
  Reviewers: 'レビュアー',
  'Fix broken checks': '失敗したチェックを修正',
  'No broken checks to fix.': '修正が必要なチェックはありません。',
  'Started an AI agent for the broken checks.':
    '失敗したチェックに対して AI Agent を開始しました。',
  'Failed to start an AI agent for the broken checks: {{value0}}':
    '失敗したチェックのため AI Agent を開始できませんでした: {{value0}}',
  'Checks unavailable': 'チェックは利用できません',
  'Checks pending': '保留中のチェック',
  checks: 'チェック',
  'Add Project': 'プロジェクトを追加',
  'Add label': 'ラベルを追加',
  'Select Team': 'チームを選択',
  'Choose project': 'プロジェクトを選択',
  'Add number': '番号を追加',
  'Add text': 'テキストを追加',
  MR: 'MR',
  mr: 'MR',
  Gitea: 'Gitea',
  gitea: 'Gitea',
  glab: 'glab',
  'GitHub Integration': 'GitHub 連携',
  'GitLab Integration': 'GitLab 連携',
  'Bitbucket Integration': 'Bitbucket 連携',
  'Azure DevOps Integration': 'Azure DevOps 連携',
  'Gitea Integration': 'Gitea 連携',
  'Jira Integration': 'Jira 連携',
  'Linear Integration': 'Linear 連携',
  'Hide Jira': 'Jira を非表示',
  'Linear issue': 'Linear イシュー',
  'Linear issues': 'Linear イシュー',
  'New Linear issue': '新規 Linear イシュー',
  'Jira issue': 'Jira イシュー',
  'Jira issues': 'Jira イシュー',
  'New Jira issue': '新規 Jira イシュー',
  'No Linear issues found': 'Linear イシューが見つかりません',
  'Unable to load Linear issues': 'Linear イシューを読み込めません',
  'No Jira issues found': 'Jira イシューが見つかりません',
  issue: 'Issue',
  issues: 'Issue',
  Issues: 'Issue',
  'Common emulator commands': 'よく使うエミュレータコマンド',
  'Pull request': 'PR',
  'pull request': 'PR',
  'Pull request merged': 'PR がマージされました',
  'Pull request reopened': 'PR が再オープンされました',
  'Pull request closed': 'PR がクローズされました',
  'Preview and edit the selected GitHub issue or pull request.':
    '選択した GitHub イシューまたは PR をプレビュー・編集します。',
  'view issues': 'イシューを表示',
  'Review requested': 'レビュー依頼済み',
  'Request reviewer {{value0}}': 'レビュアーをリクエスト {{value0}}',
  'Unrequest reviewer {{value0}}': 'レビュアーのリクエストを取り消す {{value0}}',
  'Phone preview': 'スマートフォンプレビュー',
  'Switch to phone mode': 'スマートフォンモードに切り替え',
  phone: 'スマートフォン',
  'Front Matter': 'フロントマター',
  'Publish Branch': 'ブランチを公開',
  'Issue source': 'イシューソース',
  'Sub-issue data is unavailable for your token.':
    'トークンではサブイシューデータを利用できません。',
  'Start workspace from issue': 'イシューからワークスペースを開始',
  'Install the GitHub CLI to enable pull requests, issues, and checks.':
    'GitHub CLI をインストールして PR、イシュー、チェックを有効にします。',
  'Search GitHub issues...': 'GitHub イシューを検索...',
  'file an issue': 'イシューを登録',
  sending: '送信中',
  'Pull requests, issues, and checks via the': 'PR、イシュー、チェックは',
  'Pull requests, issues, and check status.': 'PR、イシュー、チェックの状態。',
  'Pull requests and build statuses': 'PR とビルドステータス',
  'Pull requests and commit statuses for detected repositories':
    '検出されたリポジトリの PR とコミットステータス',
  'Keep at phone size (default)': 'スマートフォンサイズを維持（デフォルト）',
  // Round 5: inline/launch/action homographs, MR/review status chips, concise prompts.
  Inline: 'インライン',
  inline: 'インライン',
  Launch: '起動',
  'Launch:': '起動：',
  'Launch plan': '起動プラン',
  'Launch agent': 'Agent を起動',
  'Launch {{value0}} in a new terminal': '新規ターミナルで {{value0}} を起動',
  Play: '再生',
  Action: '操作',
  Actions: '操作',
  action: '操作',
  'More actions': 'その他の操作',
  'Quick Actions': 'クイック操作',
  'Actions & Settings': '操作と設定',
  'More PR actions': 'その他の PR 操作',
  'More PR workspace actions': 'PR ワークスペースのその他の操作',
  'More issue workspace actions': 'イシューワークスペースのその他の操作',
  'More {{value0}} actions': 'その他の {{value0}} 操作',
  'More Explorer Actions': 'エクスプローラーのその他の操作',
  'More comment actions': 'その他のコメント操作',
  'More note actions': 'その他のメモ操作',
  'More commit and remote actions': 'コミットおよびリモート操作',
  'More {{value0}} and remote actions': 'その他の {{value0}} とリモート操作',
  'Pane Actions': 'ペインの操作',
  'Project actions': 'プロジェクトの操作',
  'Project actions for {{value0}}': '{{value0}} のプロジェクト操作',
  'Group actions for {{value0}}': '{{value0}} のグループ操作',
  'Action recipes': '操作レシピ',
  'merge request': 'MR',
  MergeRequest: 'MR',
  'Reviewed by': 'レビュアー',
  'MR title is required.': 'MR タイトルは必須です。',
  'Conductor Progress': 'Conductor 進捗',
  'Conductor Review': 'Conductor レビュー',
  'Conductor Done': 'Conductor 完了',
  Blocked: 'ブロック中',
  'Needs review': 'レビュー待ち',
  'font features': 'フォント特性',
  'Merge requests, issues, todos, and pipelines via the': 'MR、イシュー、ToDo、パイプラインは',
  'Install the GitLab CLI to enable merge requests, issues, and pipelines.':
    'GitLab CLI をインストールして MR、イシュー、パイプラインを有効にします。',
  'This merge request is still a draft': 'この MR はまだ下書きです',
  'This merge request is closed': 'この MR はクローズされています',
  'This merge request is already merged': 'この MR はすでにマージされています',
  'Add a project first': 'まずプロジェクトを追加',
  'Pick a base branch below': '以下のベースブランチを選択',
  'Choose floating workspace directory': 'フローティング ワークスペース ディレクトリを選択',
  'Local project, Git repo, or folder with many repos':
    'ローカルプロジェクト、Git リポジトリ、または多数のリポジトリを含むフォルダー',
  'Enter passphrase': 'パスフレーズを入力',
  'Enter password': 'パスワードを入力',
  'Enter the passphrase for': 'のパスフレーズを入力',
  'Enter the password for': 'のパスワードを入力',
  'Choose a view': 'ビューを選択',
  'Select one project to open in GitHub': 'GitHub で開くプロジェクトを 1 つ選択',
  'Select one GitHub project to open in GitHub': 'GitHub で開く GitHub プロジェクトを 1 つ選択',
  'Select one Linear team to open in Linear': 'Linear で開く Linear チームを 1 つ選択',
  'Select a workspace to view checks': 'チェックを表示するワークスペースを選択',
  'Select a workspace to browse files': 'ファイルを参照するワークスペースを選択',
  'Select a workspace to search': '検索するワークスペースを選択',
  'Select a workspace to view changes': '変更を表示するワークスペースを選択',
  'Choose agent to fix commit failure': 'コミット失敗を修正する Agent を選択',
  'Choose an agent for this commit failure': 'このコミット失敗に対する Agent を選択',
  'Enter a commit message to commit': 'コミットメッセージを入力してコミット',
  'Choose parent folder...': '親フォルダーを選択...',
  'Check for stuck work, stale generated files, failing validation, and anything that needs human attention. Report only actionable issues.':
    'スタックした作業、古い生成ファイル、検証の失敗、および人間の対応が必要なものがないか確認してください。対応が必要なイシューのみを報告してください。',
  // Round 6: homograph/term mistranslations surfaced by a full ja.json audit.
  // Why: machine translation rendered UI terms as unrelated everyday words.
  Smart: 'スマート',
  Jobs: 'ジョブ',
  Bold: '太字',
  Strike: '取り消し線',
  thread: 'スレッド',
  Lead: 'リード',
  Assignees: '担当者',
  'Assignees:': '担当者:',
  Origin: 'オリジン',
  Force: '強制',
  Kind: '種類',
  Address: 'アドレス',
  Mouse: 'マウス',
  Home: 'ホーム',
  Move: '移動',
  Change: '変更',
  Conflicts: '競合',
  conflict: '競合',
  'unresolved conflict': '未解決の競合',
  'Next match': '次の一致',
  'Previous match': '前の一致',
  'No matches': '一致なし',
  'New Issue': '新規イシュー',
  'Issue title': 'イシューのタイトル',
  'Sub-issue title': 'サブイシューのタイトル',
  Merged: 'マージ済み',
  Behind: '遅れ',
  'Head branch': 'ヘッドブランチ',
  Import: 'インポート',
  'Import…': 'インポート…',
  'Import...': 'インポート...',
  'Re-import': '再インポート',
  Local: 'ローカル',
  local: 'ローカル',
  'Scanning...': 'スキャン中...',
  Sparse: 'スパース',
  sparse: 'スパース',
  connection: '接続',
  'Est. cost': '推定コスト',
  'Est. API-equivalent cost': 'API 相当の推定コスト',
  'Est. spend': '推定費用',
  Spend: '費用',
  'new markdown': '新規 markdown',
  working: '実行中',
  'Working…': '処理中…',
  On: 'オン',
  Hold: 'ホールド',
  'Keep alive until reset': 'リセットされるまで維持',
  Forward: '進む',
  Fresh: '新規',
  Gone: '削除済み',
  Ding: 'ディン',
  'Take back': '操作を取り戻す',
  'Mobile driving': 'モバイルで操作中',
  'Phone driving': 'スマホ操作中',
  'Mobile is driving this browser': 'モバイルがこのブラウザを操作しています',
  'Wants to run': '実行をリクエスト中',
  'No states found': 'ステータスが見つかりません',
  'Loading states': 'ステータスを読み込み中',
  vibrancy: '透過効果',
  ligature: '合字',
  Zinc: 'ジンク',
  Rose: 'ローズ',
  import: 'インポート',
  mouse: 'マウス',
  'Open job in GitLab': 'GitLab でジョブを開く',
  'Showing first 100 jobs': '最初の 100 件のジョブを表示しています',
  'Imported from Ghostty.': 'Ghostty からインポートしました。',
  'Claude Accounts': 'Claude アカウント',
  // PR/issue state badges: "Closed" is クローズ (not 閉店 = a shop closing); align "Merged" with マージ済み.
  'State: Closed': '状態: クローズ',
  'State: Merged': '状態: マージ済み',
  // Terminal/theme cursor settings = the on-screen カーソル, not the Cursor product.
  'Cursor Text': 'カーソル文字',
  'Cursor color': 'カーソル色',
  'Cursor Opacity': 'カーソルの不透明度',
  'Cursor Shape': 'カーソル形状',
  'Blinking Cursor': 'カーソルの点滅',
  'Terminal Cursor': 'ターミナルのカーソル',
  'Local folders and Git repositories': 'ローカルフォルダーと Git リポジトリ',
  'Started an AI agent for the conflicts.': '競合の解決のために AI Agent を開始しました。',
  'Previous conflict': '前の競合',
  '1 commit ahead of {{value0}}': '{{value0}} より 1 コミット進んでいます',
  '1 commit behind {{value0}}': '{{value0}} より 1 コミット遅れています',
  '3 commits ahead': '3 コミット進んでいます',
  'Fast-forwarded {{branch}} by 1 commit.': '{{branch}} を 1 コミット分 fast-forward しました。',
  'e.g. cloudflared access ssh --hostname %h': '例: cloudflared access ssh --hostname %h',
  'Git is not installed': 'Git がインストールされていません',
  'CLI not installed': 'CLI がインストールされていません',
  'Locate SDK folder': 'SDK フォルダーを選択',
  'Not found. Install Android Studio, then create a Virtual Device.':
    '見つかりません。Android Studio をインストールしてから、仮想デバイスを作成してください。',
  'ANSI blue color': 'ANSI青色',
  'MR !{{value0}}': 'MR !{{value0}}',
  mrs: 'MR',
  'No human comments.': 'ユーザーによるコメントはありません。',
  'Any state': 'すべての状態',
  State: '状態',
  Health: '健全性',
  Ordering: '並べ替え',
  Start: '開始',
  'Local {{value0}} is behind {{value1}}': 'ローカル {{value0}} は {{value1}} より遅れています',
  'behind main': 'main より遅れています',
  'behind (base commit:': '遅れ (ベースコミット:',
  'No pending todos. You’re all caught up!': '保留中の ToDo はありません。すべて完了しています！',
  High: '高',
  Medium: '中',
  Low: '低',
  'Split Terminal Down': 'ターミナルを下に分割',
  'Split Terminal Right': 'ターミナルを右に分割',
  'Split Up': '上に分割',
  'Split Down': '下に分割',
  "Install the Browser Use skill so agents can operate Orca's browser.":
    'Browser Use スキルをインストールすると、 Agent が Orca のブラウザを操作できるようになります。',
  'bold ·': '太字 ·',
  'Duplicate of another issue in this repository': 'このリポジトリ内の別の Issue と重複',
  'Choose a different issue.': '別の Issue を選択してください。',
  'No matching issues loaded.': '一致する Issue がありません。',
  'Duplicate of another issue': '別の Issue と重複',
  'mentioned this': 'がこの Issue をメンションしました',
  'closed this': 'がこの Issue をクローズしました',
  'reopened this': 'がこの Issue を再オープンしました',
  'moved this': 'がこの Issue を移動しました',
  'Failed to save setup startup behavior.': 'セットアップ時の起動設定を保存できませんでした。',
  'Failed to resolve MR base.': 'MR のベースブランチを特定できませんでした。',
  'Failed to copy context.': 'コンテキストのコピーに失敗しました。',
  // 3-way split: [this][query]["]. The closing side is already 」, so end the sentence here.
  'No settings found for "': '検索条件に一致する設定が見つかりませんでした:「',
  "Doesn't apply to agents where you've overridden launch arguments.":
    '起動引数を上書きしている Agent には適用されません。',
  'Check for Server Updates': 'サーバーの更新を確認',
  'All servers are up to date.': 'すべてのサーバーが最新です。',
  'Open worktree': 'ワークツリーを開く',
  'Update this server': 'このサーバーを更新',
  'Git repository': 'Git リポジトリ',
  '{{host}} is no longer a saved SSH host, so this workspace is no longer connected to a live host. It can only be removed from Orca — files and branches on the remote are left untouched.':
    '{{host}} は保存済みの SSH ホストではなくなったため、このワークスペースは稼働中のホストに接続されていません。Orca から削除することのみ可能です。リモート上のファイルとブランチはそのまま残ります。',
  'The app shell could not finish rendering. Retry to remount it, or relaunch Orca if the error persists.':
    'アプリシェルのレンダリングを完了できませんでした。再マウントを試すか、エラーが解決しない場合は Orca を再起動してください。',
  'Workspaces are unavailable on a mobile-scope pairing. Reconnect using the browser access link from Settings → Runtime Environments → Share this Orca server.':
    'モバイル向けペアリングではワークスペースを使用できません。[設定] → [リモート Orca サーバー] → [この Orca サーバーを共有する] から、ブラウザ用リンクで再接続してください。',
  'Change this later in Settings → Browser.': '後で [設定] → [ブラウザ] から変更できます。',
  'Orca Cloud sign-in is not configured': 'Orca Cloud へのサインインが設定されていません',
  '{{provider}} could not authenticate the credentials available in this environment. Check the {{provider}} login or environment token, then retry.':
    '{{provider}} はこの環境で利用できる認証情報で認証できませんでした。{{provider}} のログインまたは環境トークンを確認して、再試行してください。',
  'e.g. ollama run llama3.1 {prompt}': '例: ollama run llama3.1 {prompt}',
  'e.g. ollama run llama3.1 {{value0}}': '例: ollama run llama3.1 {{value0}}',
  'Connecting terminal...': 'ターミナルに接続中…',
  'Starring…': 'スターを付けています…',
  'self-hosted': 'セルフホスト',
  'not-authenticated': '未認証',
  'side-by-side': '左右に並べて',
  'Side-by-side': '左右に並べて',
  'Pull requests and commit statuses via the Gitea REST API.':
    'Gitea REST API 経由の PR とコミットステータス。',
  Key: 'キー',
  slug: 'スラッグ',
  // Rendered as [fragment][var name][fragment] by two cards that share these fragments.
  'Public repositories are detected from their git remote. Set':
    'パブリックリポジトリは git リモートから検出されます。設定:',
  'for private repositories, and set': '（プライベートリポジトリ用）。また、',
  'only when Orca cannot derive the API base URL from the git remote.':
    'は、Orca が git リモートから API のベース URL を取得できない場合のみ設定します。',
  'only when Orca cannot derive the API URL from the remote.':
    'は、Orca がリモートから API URL を取得できない場合のみ設定します。',
  Set: '設定:',
  '. Set': '。設定:',
  ', or set': '、または',
  and: 'と',
  // Concatenated: the leading space is part of the string, not padding.
  ' and ': ' と ',
  ' in {{value0}}': '（{{value0}}）',
  ' • Last scan error: {{value0}}': ' • 最終スキャンエラー: {{value0}}',
  ' vs {{value0}}': ' vs {{value0}}',
  'When you create a workspace, Orca refreshes the remote base and safely fast-forwards your matching local branch, such as':
    'ワークスペースを作成すると、Orca はリモートベースを更新し、一致するローカルブランチを安全に fast-forward します。対象は',
  '. This keeps commands like': '。これにより、',
  'from comparing against stale history. Orca skips the update if that branch has uncommitted changes or local-only commits.':
    'などのコマンドが古い履歴と比較されるのを防ぎます。対象のブランチにコミットしていない変更やローカルのみのコミットがある場合、Orca は更新をスキップします。',
  'Supports skills, file paths, and built-in commands like':
    'スキル、ファイルパス、および次のような組み込みコマンドに対応しています:',
  ' · {{value0}} external': ' · 外部 {{value0}} 件',
  'Use your current': '現在のアカウントを使用',
  Running: '実行中',
  'Back to runs': '実行一覧に戻る',
  Failed: '失敗',
  Unknown: '不明',
  'Identity file': '秘密鍵ファイル',
  'Identity File': '秘密鍵ファイル',
  key: 'キー',
  failing: '失敗',
  'Selected host': '選択したホスト',
  'Copied cleanup payload.': 'クリーンアップ用ペイロードをコピーしました。',
  'Jump to...': '移動先…',
  'Start work': '作業を開始',
  'Remove {{value0}} contained {{value1}} from Orca':
    '含まれている {{value1}} {{value0}} 件を Orca から削除',
  'People in {{orgName}} who can collaborate on Orca.':
    '{{orgName}} で Orca を共同利用できるメンバーです。',
  'People in your organization who can collaborate on Orca.':
    '組織内で Orca を共同利用できるメンバーです。',
  'Adds action recipes for Source Control commit, pull request, branch-name, and fix actions.':
    'ソース管理のコミット、PR、ブランチ名、修正操作に使うアクションレシピを追加します。',
  'Repo fallback for text actions that select Custom command.':
    '「カスタムコマンド」を選択したテキスト操作に使う、リポジトリ単位のフォールバック。',
  'Recipe-created runtimes are workspace-owned. Clean up stale entries after crashes, failed creates, or manual recovery.':
    'レシピで作成されたランタイムはワークスペースに紐づいています。クラッシュ、作成失敗、手動リカバリの後に残った古いエントリをクリーンアップします。',
  'Failed to register the recipe-created project root on the runtime.':
    'レシピによって作成されたプロジェクトルートをランタイムに登録できませんでした。',
  'Update all {{value0}} servers': '{{value0}} 台のサーバーをすべて更新',
  'This QR code grants limited (mobile) access. To use the full web app, open the browser access link from Settings → Runtime Environments → Share this Orca server → New Link.':
    'この QR コードでは、モバイル向けの制限付きアクセスのみ利用できます。完全版の Web アプリを使用するには、[設定] → [リモート Orca サーバー] → [この Orca サーバーを共有する] → [新規リンク] から、ブラウザ用アクセスリンクを開いてください。',
  'Loading skills...': 'スキルを読み込み中…',
  'Start agents on your tasks without leaving Orca': 'Orca から離れずに、タスクから Agent を開始',
  'Workspace created from {{value0}}, but Orca could not fast-forward local {{value1}} because {{value2}}':
    'ワークスペースは {{value0}} から作成されましたが、{{value2}} のため Orca はローカル {{value1}} を fast-forward できませんでした',
  'Terminal, browser, or editor rendering failed in this workspace. Retry to remount it.':
    'このワークスペースでは、ターミナル、ブラウザ、またはエディターのレンダリングに失敗しました。再マウントを試してください。',
  'The dashboard could not finish rendering. Retry to remount it, or reopen it.':
    'ダッシュボードのレンダリングを完了できませんでした。再マウントを試すか、開き直してください。',

  'Review the prompt before starting an agent.':
    'Agent を開始する前に、プロンプトを確認してください。',
  'Use Add Project to enter a path on the selected host.':
    '[プロジェクトの追加] から、選択したホスト上のパスを入力します。',
  'Use repo-relative paths like packages/web or apps/api.':
    'packages/web や apps/api などのリポジトリ相対パスを使用します。',
  'orca.yaml first, then your local commands.': 'まず orca.yaml、次にローカルのコマンドの順です。',
  'Rename Orca-created branches from the initial agent task.':
    'Orca が作成したブランチの名前を、最初の Agent タスクに基づいて変更します。',
  'Dim files matched by .gitignore in the file explorer.':
    'ファイルエクスプローラーで、.gitignore に一致するファイルを薄く表示します。',
  'Command line Orca runs when a text recipe uses Custom command.':
    'テキストレシピで「カスタムコマンド」を使用したときに Orca が実行するコマンドライン。',
  'Let programs in the terminal copy to the system clipboard through OSC 52, including over SSH.':
    'ターミナル内のプログラムが、OSC 52 を使ってシステムのクリップボードにコピーできるようにします（SSH 経由を含む）。',
  'Choose which optional saved Codex account powers live quota reads.':
    'ライブクォータの取得に使用する、保存済みの Codex アカウント（任意）を選択します。',
  'This plugin has no worker process. Its instructional content can still cause actions when you or an agent use it. Review the instructions and commands below before enabling it.':
    'このプラグインにはワーカープロセスがありません。それでも、ユーザーや Agent が使用したときに、記載された手順が操作を引き起こす可能性があります。有効にする前に、以下の手順とコマンドを確認してください。',
  'This removes the saved SSH host and its credentials from this computer. Remote files are not deleted.':
    '保存済みの SSH ホストとその認証情報を、このコンピュータから削除します。リモートのファイルは削除されません。',
  'Your new worktree is current, but local {{value0}} is {{value1}} {{value2}} behind. AI diffs may miss recent commits.':
    '新規ワークツリーは最新ですが、ローカル {{value0}} は {{value1}} {{value2}} 遅れています。AI の差分に最近のコミットが反映されない可能性があります。',
  'This check needs a manual action on GitHub (for example, approving the workflow run) before merging is unblocked.':
    'マージのブロックが解除されるまでに、このチェックには GitHub 上での手動操作（例: ワークフロー実行の承認）が必要です。',
  'This file changed on disk while you have unsaved edits. Saving will overwrite the newer disk content.':
    '未保存の編集がある状態で、このファイルがディスク上で変更されました。保存すると、ディスク上の最新の内容を上書きします。',
  'Local terminal reveal is unavailable while a remote runtime is active':
    'リモートランタイムがアクティブな間は、ローカルターミナルの表示は利用できません',
  'No quick commands saved.': '保存されているクイックコマンドはありません。',
  'Repository not in Orca': 'このリポジトリは Orca に登録されていません',
  'host folder not selected': 'ホストフォルダーが選択されていません',
  'Add a Git repository or folder that already exists on the selected host.':
    '選択したホストに既に存在する Git リポジトリまたはフォルダーを追加します。',
  'Add another project from the selected host.': '選択したホストから別のプロジェクトを追加します。',
  'Enter a host path for the clone destination.': 'クローン先のホスト上のパスを入力します。',
  'Use a host path to add projects from a remote host.':
    'ホスト上のパスを指定して、リモートホストからプロジェクトを追加します。',
  'Use Add Project to enter a host path.':
    '[プロジェクトの追加] から、ホスト上のパスを入力します。',
  'Opens as a project on this host · {{value0}}':
    'このホスト上のプロジェクトとして開きます · {{value0}}',
  'No project path is available on this host for attachments.':
    'このホスト上に、添付に使用できるプロジェクトパスがありません。',
  'Clears them from Orca only. Remote files, worktrees, and branches are left untouched.':
    'Orca からのみ削除します。リモートのファイル、ワークツリー、ブランチはそのまま残ります。',
  'Agent location': 'Agent の実行場所',
  upstream: 'upstream',
  Upstream: 'upstream',
  'Commit staged changes': 'ステージ済みの変更をコミット',
  'Generate the commit message from staged changes.':
    'ステージ済みの変更からコミットメッセージを生成します。',
  lan: 'LAN',
  deploy: 'deploy',
  'Connect this source to check for Hermes automations in the remote profile.':
    'このソースに接続すると、リモートプロファイル内の Hermes オートメーションを確認できます。',
  'Notes sent to active agent.': 'メモをアクティブな Agent に送信しました。',
  'Review before attaching. Captured page context may include visible site content.':
    '添付する前に確認してください。取得したページのコンテキストには、表示中のサイトの内容が含まれる場合があります。',
  'Agent took too long to start. The workspace is ready — paste the {{value0}} when the agent is idle.':
    'Agent の起動に時間がかかりすぎました。ワークスペースの準備はできています。 Agent がアイドル状態になったら {{value0}} を貼り付けてください。',
  'Install the Orca CLI before running agent skill setup.':
    'Agent スキルのセットアップを実行する前に、Orca CLI をインストールしてください。',
  'Run grok in a terminal on the computer running Orca and wait for it to start. If prompted, complete sign-in, then retry usage. You do not need to send a chat message.':
    'Orca を実行しているコンピュータのターミナルで grok を実行し、起動するまで待ってください。サインインを求められた場合は完了してから、使用状況を再取得してください。チャットメッセージを送る必要はありません。',
  'Choose an enabled agent before saving.': '保存する前に、有効な Agent を選択してください。',
  'Selected agent is disabled. Choose an enabled agent before creating.':
    '選択した Agent は無効です。作成する前に、有効な Agent を選択してください。',
  'Choose an agent before starting.': '開始する前に、 Agent を選択してください。',
  'Change this later from the project menu.': '後でプロジェクトメニューから変更できます。',
  "Orca works with every CLI agent. Choose the one you'll reach for most. Switch any time.":
    'Orca はすべての CLI Agent で動作します。最もよく使うものを選択してください。いつでも切り替えられます。',
  'Downloading paused': 'ダウンロード一時停止中',
  Canceled: 'キャンセル済み',
  'Thinking...': '思考中…',
  'No attached worktrees yet': '紐づくワークツリーはまだありません',
  'Started an AI agent for the commit failure.':
    'コミット失敗を修正するために AI Agent を開始しました。',
  'terminals until reset': 'リセットするまでターミナルを維持',
  'Failed to import repo icon': 'リポジトリアイコンのインポートに失敗しました',
  'Terminal Panes': 'ターミナルペイン',
  'Option composes special characters for your keyboard layout.':
    'Option キーで、キーボードレイアウトに応じた特殊文字を入力します。',
  'There are local terminals with running processes. Close the window anyway?':
    'プロセスが実行中のローカルターミナルがあります。このままウィンドウを閉じますか?',
  'Auto-generates a new name when you leave this text box empty.':
    'このテキストボックスを空のままにすると、名前が自動生成されます。',
  'Auto-name workspace from first agent message':
    '最初の Agent メッセージからワークスペース名を自動生成',
  'Controls the split divider line between panes in light mode.':
    'ライトモードでのペイン間の分割線を制御します。',
  'Controls the split divider line between panes in dark mode.':
    'ダークモードでのペイン間の分割線を制御します。',
  'Countdown timer showing time until prompt cache expires (Claude agents).':
    'プロンプトキャッシュが期限切れになるまでの時間を示すカウントダウンタイマー（Claude Agent ）。',
  'Install and manage experimental Orca plugins.':
    '実験的機能の Orca プラグインをインストール・管理します。',
  "Resident memory held by Orca plus the processes under each worktree's terminals.":
    'Orca が保持する常駐メモリと、各ワークツリーのターミナル配下で実行中のプロセス。',
  'No local Claude, Codex, or OpenCode usage found yet. The overview will populate after the next agent session writes token logs.':
    'ローカルの Claude、Codex、OpenCode の使用状況はまだ見つかりません。次の Agent セッションがトークンログを書き込むと、概要に反映されます。',
  'Choose or add a project before creating a workspace.':
    'ワークスペースを作成する前に、プロジェクトを選択または追加してください。',
  'Choose a project to get started.': '開始するには、プロジェクトを選択してください。',
  'Please enter feedback before submitting.': '送信する前に、フィードバックを入力してください。',
  'Add a Git project under this folder to attach GitHub or GitLab tasks.':
    'GitHub または GitLab のタスクを関連付けるには、このフォルダー内に Git プロジェクトを追加してください。',
  'Enter a valid website URL.': '有効な Web サイトの URL を入力してください。',
  'Choose a WSL distro before projects can inherit WSL.':
    'プロジェクトが WSL を継承できるようにするには、先に WSL ディストリビューションを選択してください。',
  'Choose a different base branch before creating a {{value0}}.':
    '{{value0}} を作成する前に、別のベースブランチを選択してください。',
  'Optional. Orca can use your normal Codex login; add accounts only if you want quick switching in Orca.':
    '任意。Orca は通常の Codex ログインを使用できます。Orca 上ですばやく切り替えたい場合にのみ、アカウントを追加してください。',
  'Optional. Orca can use your normal Claude login; add accounts only if you want quick switching without moving chat sessions.':
    '任意。Orca は通常の Claude ログインを使用できます。チャットセッションを移さずにすばやく切り替えたい場合にのみ、アカウントを追加してください。',
  'Optional. Orca works with your existing provider logins; add accounts only if you want Orca to help switch between them.':
    '任意。Orca は既存のプロバイダーのログインと連携します。Orca に切り替えを任せたい場合にのみ、アカウントを追加してください。',
  'Use this computer by default. Choose a saved server only when you want supported projects, files, terminals, provider checks, and browser/mobile handoff to run through that server.':
    '既定ではこのコンピュータを使用します。対応するプロジェクト、ファイル、ターミナル、プロバイダーチェック、ブラウザ/モバイルの引き継ぎをそのサーバー経由で実行したい場合にのみ、保存済みサーバーを選択してください。',
  'Window Blur': 'ウィンドウのぼかし',
  'Medium section heading.': '中サイズのセクション見出し。',
  'macOS Option key': 'macOS の Option キー',
  'Failed to add folder on this host': 'このホスト上でのフォルダーの追加に失敗しました',
  'This workspace is locked by Git. Run git worktree unlock <worktree-path> from its repository, then retry deletion.':
    'このワークスペースは Git によってロックされています。リポジトリで git worktree unlock <worktree-path> を実行してから、削除を再試行してください。',
  'This workspace is locked by Git. Git reported: {{value0}}. Run git worktree unlock <worktree-path> from its repository, then retry deletion.':
    'このワークスペースは Git によってロックされています。Git の報告: {{value0}}。リポジトリで git worktree unlock <worktree-path> を実行してから、削除を再試行してください。',
  'Permanently deletes the remote Git worktrees and their branches. Cannot be undone.':
    'リモートの Git ワークツリーとそのブランチを完全に削除します。この操作は取り消せません。',
  'Click a card to copy a prompt. Use these in a Linear-linked worktree after the skill is installed.':
    'カードをクリックするとプロンプトをコピーできます。スキルのインストール後、Linear にリンクしたワークツリーで使用してください。',
  'Ticket actions work best in a worktree created from Tasks so the issue stays linked as context.':
    'チケット操作は、タスクから作成したワークツリーで最も効果的です。Issue がコンテキストとしてリンクされたままになります。',
  'Choose a base branch.': 'ベースブランチを選択してください。',
  'Enter a {{value0}} title.': '{{value0}} のタイトルを入力してください。',
  'Enter a valid five-field cron before saving.':
    '保存する前に、有効な 5 フィールドの cron を入力してください。',
  'Choose an available workspace before saving.':
    '保存する前に、使用可能なワークスペースを選択してください。',
  'Enter a valid advanced schedule before saving.':
    '保存する前に、有効な詳細スケジュールを入力してください。',
  'Creating...': '作成中…',
  'Creating…': '作成中…',
  'Reopening...': '再オープン中…',
  'Thinking…': '思考中…',
  'Hide from sidebar': 'サイドバーから非表示',
  'Show in sidebar': 'サイドバーに表示',
  'Recent or tab strip.': '「最近」またはタブストリップ。',
  // Settings-search keywords: proper nouns keep their canonical spelling, and the rest were
  // translated in the wrong sense (windows→窓, gitignore→ギティ無視, component→成分).
  windows: 'Windows',
  'windows powershell': 'Windows PowerShell',
  'powershell 7': 'PowerShell 7',
  neovim: 'Neovim',
  hermes: 'Hermes',
  duckduckgo: 'DuckDuckGo',
  gitignore: 'gitignore',
  component: 'コンポーネント',
  compose: '特殊文字の入力',
  sidekick: 'Sidekick',
  'api token': 'API トークン',
  'compare base': '比較ベース',
  ahead: '進んでいる'
}

export const JA_VALUE_OVERRIDES = { ...JA_AUDIT_OVERRIDES, ...JA_UNIFIED_VALUES }
