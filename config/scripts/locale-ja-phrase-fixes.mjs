// Japanese phrase fixes from high-visibility UI audit rounds 1–4.
// Why: keep locale-phrase-fixes.mjs under max-lines while preserving repair coverage.
export const JA_PHRASE_FIXES = [
  { pattern: /解雇/g, replacement: '閉じる', whenEnIncludes: 'Dismiss' },
  { pattern: /却下/g, replacement: '閉じる', whenEnIncludes: 'Dismiss' },
  { pattern: /代理人/g, replacement: 'エージェント', whenEnIncludes: 'agent' },
  { pattern: /支店/g, replacement: 'ブランチ', whenEnIncludes: 'ranch' },
  { pattern: /港(?!口)/g, replacement: 'ポート', whenEnIncludes: 'ort' },
  { pattern: /会議/g, replacement: 'セッション', whenEnIncludes: 'session' },
  { pattern: /広報/g, replacement: 'PR', whenEnIncludes: 'PR' },
  { pattern: /端末/g, replacement: 'ターミナル', whenEnIncludes: 'erminal' },
  { pattern: /シャチ:\/\//g, replacement: 'orca://', whenEnIncludes: 'orca://' },
  { pattern: /線形/g, replacement: 'Linear', whenEnIncludes: 'Linear' },
  { pattern: /グラフQL/g, replacement: 'GraphQL', whenEnIncludes: 'GraphQL' },
  { pattern: /不和/g, replacement: 'Discord', whenEnIncludes: 'Discord' },
  { pattern: /爽やか/g, replacement: '更新中', whenEnIncludes: 'Refreshing' },
  { pattern: /殺害/g, replacement: '終了中', whenEnIncludes: 'Killing' },
  { pattern: /殺す/g, replacement: '強制終了', whenEnIncludes: 'Kill' },
  { pattern: /皆殺し/g, replacement: 'すべて終了', whenEnIncludes: 'kill all' },
  { pattern: /崩壊させる/g, replacement: '折りたたむ', whenEnIncludes: 'Collapse Orca' },
  { pattern: /崩壊/g, replacement: '折りたたむ', whenEnIncludes: 'Collapse' },
  { pattern: /一般的な/g, replacement: '一般', whenEnIncludes: 'General' },
  { pattern: /高度な/g, replacement: '詳細設定', whenEnIncludes: 'Advanced' },
  { pattern: /実験的(?!機能)/g, replacement: '実験的機能', whenEnIncludes: 'Experimental' },
  {
    pattern: /コンピュータの使用/g,
    replacement: 'コンピュータ操作',
    whenEnIncludes: 'Computer Use'
  },
  { pattern: /検索設定/g, replacement: '設定を検索', whenEnIncludes: 'Search settings' },
  { pattern: /検索スキル/g, replacement: 'スキルを検索', whenEnIncludes: 'Search skills' },
  { pattern: /検索ブロック/g, replacement: 'ブロックを検索', whenEnIncludes: 'Search blocks' },
  { pattern: /暗い/g, replacement: 'ダーク', whenEnIncludes: 'Dark' },
  { pattern: /もう一度やり直してください/g, replacement: '再試行', whenEnIncludes: 'Try Again' },
  {
    pattern: /今すぐ再起動してください/g,
    replacement: '今すぐ再起動',
    whenEnIncludes: 'Restart now'
  },
  { pattern: /待っている/g, replacement: '待機中', whenEnIncludes: 'Waiting' },
  {
    pattern: /眠っているのを隠す/g,
    replacement: 'スリープ中を非表示',
    whenEnIncludes: 'Hide sleeping'
  },
  { pattern: /インタフェース/g, replacement: 'インターフェース', whenEnIncludes: 'Interface' },
  { pattern: /統合/g, replacement: '連携', whenEnIncludes: 'Integration' },
  {
    pattern: /統合しました/g,
    replacement: 'マージしました',
    whenEnIncludes: 'Merged MR'
  },
  {
    pattern: /統合されています/g,
    replacement: 'マージされています',
    whenEnIncludes: 'already merged'
  },
  { pattern: /再起動します/g, replacement: '再起動', whenEnIncludes: 'Restart Orca' },
  { pattern: /オウムガイ/g, replacement: 'Nautilus', whenEnIncludes: 'Nautilus' },
  {
    pattern: /Kim サブスクリプション/g,
    replacement: 'Kimi サブスクリプション',
    whenEnIncludes: 'Kimi subscription'
  },
  { pattern: /空き状況/g, replacement: '利用可否', whenEnIncludes: 'availability' },
  { pattern: /指示/g, replacement: 'コマンド', whenEnIncludes: 'Command' },
  { pattern: /弦/g, replacement: '文字列', whenEnIncludes: 'string' },
  { pattern: /新しい/g, replacement: '新規', whenEnIncludes: 'New' },
  {
    pattern: /Open Linearタスク/g,
    replacement: 'Linear タスクを開く',
    whenEnIncludes: 'Open Linear tasks'
  },
  { pattern: /小切手/g, replacement: 'チェック', whenEnIncludes: 'checks' },
  { pattern: /査読者/g, replacement: 'レビュアー', whenEnIncludes: 'reviewer' },
  { pattern: /レビュー担当者/g, replacement: 'レビュアー', whenEnIncludes: 'reviewer' },
  { pattern: /電話機/g, replacement: 'スマートフォン', whenEnIncludes: 'phone' },
  {
    pattern: /壊れたチェック/g,
    replacement: '失敗したチェック',
    whenEnIncludes: 'broken check'
  },
  {
    pattern: /コンピューターの使用/g,
    replacement: 'コンピュータ操作',
    whenEnIncludes: 'Computer Use'
  },
  {
    pattern: /コンピューター使用/g,
    replacement: 'コンピュータ操作',
    whenEnIncludes: 'Computer Use'
  },
  { pattern: /携帯電話/g, replacement: 'スマートフォン', whenEnIncludes: 'phone' },
  {
    pattern: /実験的機能な/g,
    replacement: '実験的機能',
    whenEnIncludes: 'experimental'
  },
  { pattern: /ジラ/g, replacement: 'Jira', whenEnIncludes: 'Jira' },
  { pattern: /ジラ/g, replacement: 'Jira', whenEnIncludes: 'jira' },
  { pattern: /Linear問題/g, replacement: 'Linear イシュー', whenEnIncludes: 'Linear issue' },
  { pattern: /Linearの問題/g, replacement: 'Linear イシュー', whenEnIncludes: 'Linear issue' },
  { pattern: /Jira の問題/g, replacement: 'Jira イシュー', whenEnIncludes: 'Jira issue' },
  {
    pattern: /一般的なアクション/g,
    replacement: 'よく使うアクション',
    whenEnIncludes: 'common actions'
  },
  { pattern: /Jira 課題/g, replacement: 'Jira イシュー', whenEnIncludes: 'issue' },
  { pattern: /GitHub の課題/g, replacement: 'GitHub イシュー', whenEnIncludes: 'issue' },
  { pattern: /サブ課題/g, replacement: 'サブイシュー', whenEnIncludes: 'sub-issue' },
  { pattern: /課題タイプ/g, replacement: 'イシュータイプ', whenEnIncludes: 'issue' },
  { pattern: /課題セット/g, replacement: 'イシューセット', whenEnIncludes: 'issue' },
  { pattern: /課題から/g, replacement: 'イシューから', whenEnIncludes: 'issue' },
  { pattern: /課題に/g, replacement: 'イシューに', whenEnIncludes: 'issue' },
  { pattern: /課題を/g, replacement: 'イシューを', whenEnIncludes: 'issue' },
  { pattern: /課題の/g, replacement: 'イシューの', whenEnIncludes: 'issue' },
  { pattern: /GitHub の問題/g, replacement: 'GitHub イシュー', whenEnIncludes: 'issue' },
  { pattern: /GitLab の問題/g, replacement: 'GitLab イシュー', whenEnIncludes: 'issue' },
  {
    pattern: /問題ワークスペース/g,
    replacement: 'イシューワークスペース',
    whenEnIncludes: 'issue'
  },
  { pattern: /問題元/g, replacement: 'イシューソース', whenEnIncludes: 'issue' },
  { pattern: /問題識別子/g, replacement: 'イシュー識別子', whenEnIncludes: 'issue' },
  { pattern: /問題タイプ/g, replacement: 'イシュータイプ', whenEnIncludes: 'issue' },
  { pattern: /問題の種類/g, replacement: 'イシューの種類', whenEnIncludes: 'issue' },
  { pattern: /問題の説明/g, replacement: 'イシューの説明', whenEnIncludes: 'issue' },
  { pattern: /問題の URL/g, replacement: 'イシューの URL', whenEnIncludes: 'issue' },
  { pattern: /問題番号/g, replacement: 'イシュー番号', whenEnIncludes: 'issue' },
  { pattern: /問題ソース/g, replacement: 'イシューソース', whenEnIncludes: 'issue' },
  { pattern: /問題自動化/g, replacement: 'イシュー自動化', whenEnIncludes: 'issue' },
  { pattern: /問題コマンド/g, replacement: 'イシューコマンド', whenEnIncludes: 'issue' },
  { pattern: /サブ問題/g, replacement: 'サブイシュー', whenEnIncludes: 'sub-issue' },
  { pattern: /新規問題/g, replacement: '新規イシュー', whenEnIncludes: 'issue' },
  { pattern: /GH問題/g, replacement: 'GH イシュー', whenEnIncludes: 'issue' },
  { pattern: /問題 #/g, replacement: 'イシュー #', whenEnIncludes: 'issue' },
  { pattern: /問題を表示/g, replacement: 'イシューを表示', whenEnIncludes: 'view issues' },
  { pattern: /問題を検索/g, replacement: 'イシューを検索', whenEnIncludes: 'issue' },
  { pattern: /問題を編集/g, replacement: 'イシューを編集', whenEnIncludes: 'issue' },
  { pattern: /問題を提出/g, replacement: 'イシューを登録', whenEnIncludes: 'file an issue' },
  { pattern: /問題の作成/g, replacement: 'イシューの作成', whenEnIncludes: 'issue' },
  { pattern: /問題を更新/g, replacement: 'イシューを更新', whenEnIncludes: 'issue' },
  { pattern: /問題を読み込/g, replacement: 'イシューを読み込', whenEnIncludes: 'issue' },
  { pattern: /問題を作成/g, replacement: 'イシューを作成', whenEnIncludes: 'issue' },
  { pattern: /問題を開く/g, replacement: 'イシューを開く', whenEnIncludes: 'issue' },
  { pattern: /問題に関連/g, replacement: 'イシューに関連', whenEnIncludes: 'issue' },
  { pattern: /問題には/g, replacement: 'イシューには', whenEnIncludes: 'issue' },
  {
    pattern: /問題を表示しています/g,
    replacement: 'イシューを表示しています',
    whenEnIncludes: 'issue'
  },
  {
    pattern: /選択した問題を/g,
    replacement: '選択したイシューを',
    whenEnIncludes: 'selected issue'
  },
  {
    pattern: /プロジェクトの問題/g,
    replacement: 'プロジェクトのイシュー',
    whenEnIncludes: 'project issues'
  },
  {
    pattern: /フェッチされた問題/g,
    replacement: '取得済みイシュー',
    whenEnIncludes: 'fetched issues'
  },
  {
    pattern: /割り当てられた問題/g,
    replacement: '割り当てられたイシュー',
    whenEnIncludes: 'assigned issues'
  },
  { pattern: /一致する問題/g, replacement: '一致するイシュー', whenEnIncludes: 'issues match' },
  {
    pattern: /範囲が限定された問題/g,
    replacement: 'スコープされたイシュー',
    whenEnIncludes: 'scoped issues'
  },
  { pattern: /GitHubの問題/g, replacement: 'GitHub イシュー', whenEnIncludes: 'GitHub issues' },
  { pattern: /ドラフト_問題/g, replacement: 'DRAFT_ISSUE', whenEnIncludes: 'DRAFT_ISSUE' },
  { pattern: /、問題、/g, replacement: '、イシュー、', whenEnIncludes: 'issues' },
  { pattern: /PR、問題/g, replacement: 'PR、イシュー', whenEnIncludes: 'issues' },
  { pattern: /GitHub 発行/g, replacement: 'GitHub イシュー', whenEnIncludes: 'issue' },
  { pattern: /github発行/g, replacement: 'github イシュー', whenEnIncludes: 'issue' },
  { pattern: /発行コマンド/g, replacement: 'イシューコマンド', whenEnIncludes: 'issue' },
  { pattern: /発行自動化/g, replacement: 'イシュー自動化', whenEnIncludes: 'issue' },
  { pattern: /サブ発行/g, replacement: 'サブイシュー', whenEnIncludes: 'sub-issue' },
  { pattern: /発行元/g, replacement: 'イシューソース', whenEnIncludes: 'Issue source' },
  { pattern: /、発行、/g, replacement: '、イシュー、', whenEnIncludes: 'issues' },
  { pattern: /プルリクエスト/g, replacement: 'PR', whenEnIncludes: 'pull request' },
  { pattern: /プル リクエスト/g, replacement: 'PR', whenEnIncludes: 'pull request' },
  { pattern: /プルリクエスト/g, replacement: 'PR', whenEnIncludes: 'PR' },
  { pattern: /プル リクエスト/g, replacement: 'PR', whenEnIncludes: 'PR' },
  { pattern: /電話プレビュー/g, replacement: 'スマートフォンプレビュー', whenEnIncludes: 'phone' },
  { pattern: /電話モード/g, replacement: 'スマートフォンモード', whenEnIncludes: 'phone' },
  { pattern: /電話サイズ/g, replacement: 'スマートフォンサイズ', whenEnIncludes: 'phone' },
  {
    pattern: /コンピュータと電話/g,
    replacement: 'コンピューターとスマートフォン',
    whenEnIncludes: 'phone'
  },
  { pattern: /前の問題/g, replacement: 'フロントマター', whenEnIncludes: 'Front Matter' },
  { pattern: /ブランチの発行/g, replacement: 'ブランチを公開', whenEnIncludes: 'Publish Branch' },
  { pattern: /ボタン​​/g, replacement: 'ボタン', whenEnIncludes: 'button' },
  {
    pattern: /レビューが要求されました/g,
    replacement: 'レビュー依頼済み',
    whenEnIncludes: 'Review requested'
  },
  // Round 5: inline/launch/action homographs, MR phrases, concise UI prompts.
  { pattern: /列をなして/g, replacement: 'インライン', whenEnIncludes: 'Inline' },
  { pattern: /列をなして/g, replacement: 'インライン', whenEnIncludes: 'inline' },
  { pattern: /打ち上げ/g, replacement: '起動', whenEnIncludes: 'Launch' },
  { pattern: /打ち上げ/g, replacement: '起動', whenEnIncludes: 'launch' },
  { pattern: /遊ぶ/g, replacement: 'Play', whenEnIncludes: 'Play' },
  { pattern: /指揮者/g, replacement: 'Conductor', whenEnIncludes: 'Conductor' },
  { pattern: /マージリクエスト/g, replacement: 'MR', whenEnIncludes: 'merge request' },
  { pattern: /マージ リクエスト/g, replacement: 'MR', whenEnIncludes: 'merge request' },
  { pattern: /レビュー者/g, replacement: 'レビュアー', whenEnIncludes: 'Reviewed by' },
  { pattern: /肩書き/g, replacement: 'タイトル', whenEnIncludes: 'title is required' },
  { pattern: /見直しが必要/g, replacement: 'レビュー待ち', whenEnIncludes: 'Needs review' },
  {
    pattern: /実用的な問題/g,
    replacement: '対応が必要なイシュー',
    whenEnIncludes: 'actionable issues'
  },
  { pattern: /アクションレシピ/g, replacement: '操作レシピ', whenEnIncludes: 'Action recipes' },
  { pattern: /クイックアクション/g, replacement: 'クイック操作', whenEnIncludes: 'Quick Actions' },
  { pattern: /さらなるアクション/g, replacement: 'その他の操作', whenEnIncludes: 'More actions' },
  {
    pattern: /その他の PR アクション/g,
    replacement: 'その他の PR 操作',
    whenEnIncludes: 'More PR actions'
  },
  { pattern: /アクション/g, replacement: '操作', whenEnIncludes: 'action' },
  { pattern: /を選択してください/g, replacement: 'を選択', whenEnIncludes: 'Select' },
  { pattern: /を選択してください/g, replacement: 'を選択', whenEnIncludes: 'Choose' },
  { pattern: /入力してください/g, replacement: '入力', whenEnIncludes: 'Enter' },
  { pattern: /追加してください/g, replacement: '追加', whenEnIncludes: 'Add' },
  { pattern: /試してください/g, replacement: '試す', whenEnIncludes: 'Try' },
  // Why: JP engineers use "Issue" in Latin, not katakana. Runs last so all *→イシュー fixes above normalize to Issue.
  { pattern: /イシュー/g, replacement: 'Issue', whenEnIncludes: 'issue' }
]
