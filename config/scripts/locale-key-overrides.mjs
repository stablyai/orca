import { KO_KEY_OVERRIDES } from './locale-ko-key-overrides.mjs'

// Key-specific overrides from high-visibility UI audit (P0/P1/P2).
// Why: some fixes depend on full key context, not English value alone.
export const LOCALE_KEY_OVERRIDES = {
  // "Open in" is a submenu header for "open in <app>"; bare で開く reads as broken JP.
  'auto.components.sidebar.WorktreeOpenInMenu.8009ab69a6': { ja: 'アプリで開く' },
  // "Assigned to me" filter; the MT past-passive 割り当てられました reads as a sentence, not a filter label.
  'auto.components.TaskPage.94f0339621': { ja: '私に割り当てられた Issue' },
  // aria-label describing the assignee picker state; the past-passive sentence reads oddly for a static label.
  'auto.components.TaskPage.bb63046423': { ja: '{{value0}} に割り当て済み' },
  // Bare "Cursor" terminal/theme settings = on-screen カーソル, not the Cursor product.
  'auto.components.settings.TerminalWindowSection.c9e1fdf42f': { ja: 'カーソル' },
  'auto.components.onboarding.ThemeStep.ab2a583a97': { ja: 'カーソル' },
  'menu.reportCrash': { ko: '크래시 신고...', zh: '报告崩溃...', ja: 'クラッシュを報告...' },
  'menu.showMobileButton': {
    ko: 'Orca 모바일 버튼 표시',
    zh: '显示 Orca Mobile 按钮',
    ja: 'Orca モバイル ボタンを表示'
  },
  'menu.toggleLeftSidebar': {
    ko: '왼쪽 사이드바 표시/숨기기',
    zh: '显示/隐藏左侧边栏',
    ja: '左サイドバーの表示/非表示'
  },
  'menu.toggleRightSidebar': {
    ko: '오른쪽 사이드바 표시/숨기기',
    zh: '显示/隐藏右侧边栏',
    ja: '右サイドバーの表示/非表示'
  },
  'menu.openWorktreePalette': {
    ko: '워크트리 팔레트 열기',
    zh: '打开工作树面板',
    ja: 'ワークツリーパレットを開く'
  },
  'menu.exploreOrca': { ko: 'Orca 둘러보기', zh: '探索 Orca', ja: 'Orca を探索' },
  'worktreeJumpPalette.matchLabel.issue': { ko: '이슈', zh: '议题', ja: 'Issue' },
  'worktreeJumpPalette.matchLabel.comment': { ko: '댓글', zh: '评论', ja: 'コメント' },
  'auto.hooks.useSettingsNavigationMetadata.13241992bd': {
    ko: '일반',
    zh: '通用',
    ja: '一般'
  },
  'auto.hooks.useSettingsNavigationMetadata.93d88d20bf': {
    ko: '외관',
    zh: '外观',
    ja: '外観'
  },
  'auto.hooks.useSettingsNavigationMetadata.1cd25673df': {
    ko: '모바일',
    zh: '移动端',
    ja: 'モバイル'
  },
  'auto.hooks.useSettingsNavigationMetadata.6a50cdcd7c': {
    ko: '음성',
    zh: '语音',
    ja: '音声'
  },
  'auto.hooks.useSettingsNavigationMetadata.580a04cd81': {
    ko: '고급',
    zh: '高级',
    ja: '詳細設定'
  },
  'auto.hooks.useSettingsNavigationMetadata.225071c560': {
    ko: '실험적',
    zh: '实验性',
    ja: '実験的機能'
  },
  'auto.hooks.useSettingsNavigationMetadata.b35e92364b': {
    ko: '컴퓨터 사용',
    zh: '计算机控制',
    ja: 'コンピュータ操作'
  },
  'auto.hooks.useSettingsNavigationMetadata.94295ebfb3': {
    ko: '단축키',
    zh: '快捷键',
    ja: 'ショートカット'
  },
  'auto.hooks.useSettingsNavigationMetadata.ded9e9032f': {
    ko: '온보딩 체크리스트',
    zh: '入门清单',
    ja: 'オンボーディングチェックリスト'
  },
  'auto.hooks.useSettingsNavigationMetadata.3618579df6': {
    ko: '개인정보 및 텔레메트리',
    zh: '隐私与遥测',
    ja: 'プライバシーとテレメトリ'
  },
  'auto.hooks.useSettingsNavigationMetadata.65b19f5bde': {
    ko: '플로팅 워크스페이스',
    zh: '浮动工作区',
    ja: 'フローティングワークスペース'
  },
  'auto.hooks.useSettingsNavigationMetadata.2b043783ef': {
    ko: '연동',
    zh: '集成',
    ja: '連携'
  },
  'auto.components.settings.Settings.9abb9be3bc': {
    ko: '설정 시작',
    zh: '初始设置',
    ja: 'セットアップ'
  },
  'auto.components.settings.SettingsSidebar.dbceaa8840': {
    ko: '설정 검색',
    zh: '搜索设置',
    ja: '設定を検索'
  },
  'auto.components.settings.SettingsSidebar.60f8a673a7': {
    ko: '앱으로 돌아가기',
    zh: '返回应用',
    ja: 'アプリに戻る'
  },
  'auto.components.settings.SettingsSidebar.82db1b7de4': {
    ko: '온보딩 체크리스트, {{value0}}/{{value1}} 완료. 설정 가이드 보기.',
    zh: '入门清单，已完成 {{value0}}/{{value1}}。显示设置指南。',
    ja: 'オンボーディングチェックリスト、{{value0}}/{{value1}} 完了。セットアップガイドを表示。'
  },
  'auto.components.settings.ShortcutFilterRail.02dc7d4251': {
    ko: '바로가기 검색',
    zh: '搜索快捷键',
    ja: 'ショートカットを検索'
  },
  'auto.components.settings.ShortcutBindingRow.6a7848fdac': {
    ko: '단축키 입력 대기 중',
    zh: '正在录制快捷键',
    ja: 'ショートカットを記録中'
  },
  'auto.components.FirstLaunchBanner.fc5cc29955': {
    ko: '거부',
    zh: '退出',
    ja: 'オプトアウト'
  },
  'auto.components.FirstLaunchBanner.94cc673726': {
    ko: '확인',
    zh: '知道了',
    ja: '了解'
  },
  'auto.components.GitHubItemDialog.55962099bc': {
    ko: '이 이슈를 열었습니다',
    zh: '创建了此议题',
    ja: 'このイシューを作成しました'
  },
  'auto.components.GitHubItemDialog.726db41722': {
    ko: '워크스페이스 열기',
    zh: '打开工作区',
    ja: 'ワークスペースを開く'
  },
  'auto.components.GitHubItemDialog.a459866967': {
    ko: 'PR에 연결된 워크스페이스 재개',
    zh: '恢复关联 PR 的工作区',
    ja: 'PR に紐づくワークスペースを再開'
  },
  'auto.components.PullRequestItemDialog.67d881244c': {
    ko: 'PR에 연결된 워크스페이스 재개',
    zh: '恢复关联 PR 的工作区',
    ja: 'PR に紐づくワークスペースを再開'
  },
  'auto.components.GitHubItemDialog.ab050dffec': {
    ko: '닫힘',
    zh: '已关闭',
    ja: 'クローズ'
  },
  'auto.components.GitHubItemDialog.dc1ca081a8': {
    ko: '진행 중',
    zh: '进行中',
    ja: 'オープン'
  },
  'auto.components.tab.bar.TabBarCreateEntry.b27864279e': {
    ko: '에이전트 실행',
    zh: '启动代理',
    ja: 'エージェントを起動'
  },
  'auto.components.sidebar.SidebarNav.c39ab10000': {
    ko: 'Linear 작업 열기',
    zh: '打开 Linear 任务',
    ja: 'Linear タスクを開く'
  },
  'auto.components.sidebar.SidebarNav.c86d83b5c3': {
    ko: '새로 만들기',
    zh: '新建',
    ja: '新規'
  },
  'auto.components.sidebar.SidebarSettingsHelpMenu.eb9884e55b': {
    ko: 'Discord',
    zh: 'Discord',
    ja: 'Discord'
  },
  'auto.components.sidebar.SidebarSettingsHelpMenu.ad3d3ed7f1': {
    ko: 'Orca 재시작',
    zh: '重启 Orca',
    ja: 'Orca を再起動'
  },
  'auto.components.sidebar.workspace.status.5f9ca31a84': {
    ko: '대기 중',
    zh: '等待中',
    ja: '待機中'
  },
  'auto.components.sidebar.SidebarWorkspaceFilterSection.ed1611b65b': {
    ko: '슬립 중인 항목 숨기기',
    zh: '隐藏休眠项',
    ja: 'スリープ中を非表示'
  },
  'auto.components.status.bar.ResourceUsageStatusSegment.4bb076fa89': {
    ko: '강제 종료',
    zh: '强制结束',
    ja: '強制終了'
  },
  'auto.components.status.bar.ResourceUsageStatusSegment.41ae4fa725': {
    ko: '종료 중…',
    zh: '正在结束…',
    ja: '終了中…'
  },
  'auto.components.status.bar.ResourceUsageStatusSegment.53dd5560ae': {
    ko: 'Orca 접기',
    zh: '折叠 Orca',
    ja: 'Orca を折りたたむ'
  },
  'auto.components.settings.ManageSessionsSection.a06ababda0': {
    ko: '모두 강제 종료',
    zh: '全部强制结束',
    ja: 'すべて強制終了'
  },
  'auto.components.settings.ManageSessionKillDialog.d3dba51b15': {
    ko: '종료 중…',
    zh: '正在结束…',
    ja: '終了中…'
  },
  'auto.components.settings.terminal.search.920573d65b': {
    ko: '모두 종료',
    zh: '全部结束',
    ja: 'すべて終了'
  },
  'auto.components.settings.AgentsPane.2e45ca29b6': {
    ko: '명령',
    zh: '命令',
    ja: 'コマンド'
  },
  'auto.components.settings.AgentsPane.1c9a9679ec': {
    ko: '{{value0}} 사용 가능 여부',
    zh: '{{value0}} 可用性',
    ja: '{{value0}} の利用可否'
  },
  'auto.components.settings.AgentsPane.ed3e110e61': {
    ko: '감지됨',
    zh: '已检测',
    ja: '検出済み'
  },
  'auto.components.settings.AgentsPane.e8da2af684': {
    ko: '설치 가능',
    zh: '可安装',
    ja: 'インストール可能'
  },
  'auto.components.settings.AppearancePane.7d26ccabe8': {
    ko: '다크',
    zh: '深色',
    ja: 'ダーク'
  },
  'auto.components.settings.BrowserUsePane.de9b2f32f3': {
    ko: '활성화',
    zh: '启用',
    ja: '有効化'
  },
  'auto.components.settings.GeneralSupportSection.73b327e793': {
    ko: '다시 시도',
    zh: '重试',
    ja: '再試行'
  },
  'auto.components.settings.PrivacyDiagnosticBundleControls.2801d4ce22': {
    ko: '참조 ID 복사',
    zh: '复制参考 ID',
    ja: '参照 ID をコピー'
  },
  'auto.components.settings.ComputerUsePane.4b65070096': {
    ko: 'darwin',
    zh: 'darwin',
    ja: 'darwin'
  },
  'auto.components.settings.ComputerUsePane.bf51e4a542': {
    ko: 'USB 장치',
    zh: 'USB 设备',
    ja: 'USB デバイス'
  },
  'auto.components.settings.OrchestrationSkillAgentCoverage.ffe13e36fb': {
    ko: '누락',
    zh: '缺失',
    ja: '不足'
  },
  'auto.components.settings.GitPane.eec3995dc6': {
    ko: 'Git AI Author',
    zh: 'Git AI Author',
    ja: 'Git AI Author'
  },
  'auto.components.settings.AutoRenameBranchFromWorkSetting.1626524572': {
    ko: 'Nautilus',
    zh: 'Nautilus',
    ja: 'Nautilus'
  },
  'auto.components.settings.Settings.8bd117d669': {
    ko: '인터페이스',
    zh: '界面',
    ja: 'インターフェース'
  },
  'auto.components.settings.SettingsThemePicker.9119fb2268': {
    ko: '현재',
    zh: '当前',
    ja: '現在'
  },
  'auto.components.settings.SettingsThemePicker.4e11f87ca6': {
    ko: '표시 중',
    zh: '显示中',
    ja: '表示中'
  },
  'auto.components.skills.SkillsPage.a68dee6a32': {
    ko: '스킬 검색',
    zh: '搜索技能',
    ja: 'スキルを検索'
  },
  'auto.components.editor.RichMarkdownSlashMenu.550189b06c': {
    ko: '블록 검색',
    zh: '搜索块',
    ja: 'ブロックを検索'
  },
  'auto.components.TaskPage.eec0c5c079': {
    ko: 'Linear 이슈 검색...',
    zh: '搜索 Linear 议题...',
    ja: 'Linear イシューを検索...'
  },
  'auto.web.WebConnect.e3bcd082ac': {
    ko: 'Orca에 연결',
    zh: '连接到 Orca',
    ja: 'Orca に接続'
  },
  'auto.App.caea5b51b9': {
    ko: '지금 재시작',
    zh: '立即重启',
    ja: '今すぐ再起動'
  },
  'auto.App.9f0152563e': { ko: '모바일', zh: '移动端', ja: 'モバイル' },
  'auto.App.ca6c6eece7': { ko: '스킬', zh: '技能', ja: 'スキル' },
  'auto.App.62ca9895a7': { ko: '스페이스', zh: '空间', ja: 'スペース' },
  'settings.appearance.statusBar.kimiToggleDescription': {
    ko: '활성 워크스페이스의 Kimi 구독 사용량을 표시합니다.',
    zh: 'Kimi 订阅',
    ja: 'Kimi サブスクリプション'
  },
  'auto.components.mobile.MobileHero.cd4e5e816f': {
    ko: '주머니 속의 워크스페이스.',
    zh: '您的工作区就在您的口袋里。',
    ja: 'ワークスペースをポケットに。'
  },
  'auto.components.GitHubItemDialog.dbe5e2448e': {
    ko: 'PR이 병합되었습니다',
    zh: '拉取请求已合并',
    ja: 'PR がマージされました'
  },
  'auto.components.PullRequestPage.c57873d721': {
    ko: 'PR이 병합되었습니다',
    zh: '拉取请求已合并',
    ja: 'PR がマージされました'
  },
  'auto.components.TaskPage.a161925adc': {
    ko: 'PR이 병합되었습니다',
    zh: '拉取请求已合并',
    ja: 'PR がマージされました'
  },
  'auto.components.JiraIssueWorkspace.857bd2f88f': {
    ko: '선택한 이슈를 미리보기하고, 편집하고, 작업을 시작하세요.',
    zh: '预览、编辑并从选定的议题开始工作。',
    ja: '選択したイシューをプレビュー・編集し、そこから作業を開始します。'
  },
  'auto.components.LinearIssueWorkspace.ad5dec37b7': {
    ko: '선택한 이슈를 미리보기하고, 편집하고, 작업을 시작하세요.',
    zh: '预览、编辑并从选定的议题开始工作。',
    ja: '選択したイシューをプレビュー・編集し、そこから作業を開始します。'
  },
  'auto.components.TaskPage.67662ade50': {
    ko: '프로젝트 이슈',
    zh: '项目议题',
    ja: 'プロジェクトのイシュー'
  },
  'auto.components.TaskPage.618107fab3': {
    ko: '선택한 팀과 일치하는 가져온 이슈가 없습니다',
    zh: '没有获取到与所选团队匹配的议题',
    ja: '選択したチームと一致する取得済みイシューはありません'
  },
  'auto.components.TaskPage.1e1b2ad8f2': {
    ko: '이 이슈를 등록하기 전에 프로젝트 워크스페이스에서 팀을 선택하세요.',
    zh: '在提交此议题之前，请从项目工作区选择一个团队。',
    ja: 'このイシューを登録する前に、プロジェクトワークスペースからチームを選択してください。'
  },
  'auto.components.TaskPage.d079be2dc8': {
    ko: '할당된 이슈가 없습니다. 검색해 보세요.',
    zh: '没有分配的议题。请尝试搜索。',
    ja: '割り当てられたイシューはありません。検索してみてください。'
  },
  'auto.components.TaskPage.94d900518d': {
    ko: '선택한 프리셋과 일치하는 이슈가 없습니다.',
    zh: '没有与所选预设匹配的议题。',
    ja: '選択したプリセットに一致するイシューはありません。'
  },
  'auto.components.github.project.ProjectCell.ffeff79861': {
    ko: 'PULL_REQUEST',
    zh: 'PULL_REQUEST',
    ja: 'PULL_REQUEST'
  },
  'auto.components.github.project.ProjectRow.c3b81ddea2': {
    ko: 'DRAFT_ISSUE',
    zh: 'DRAFT_ISSUE',
    ja: 'DRAFT_ISSUE'
  },
  'auto.components.linear.project.view.surfaces.3ad562bdf4': {
    ko: '범위가 지정된 이슈',
    zh: '范围议题',
    ja: 'スコープされたイシュー'
  },
  'auto.components.linear.project.view.surfaces.7616c986c6': {
    ko: '{{value0}} 이슈 열기',
    zh: '打开 {{value0}} 议题',
    ja: '{{value0}} イシューを開く'
  },
  'auto.components.sidebar.SidebarFeedbackDialog.d245c4ef6c': {
    ko: 'GitHub 이슈',
    zh: 'GitHub 议题',
    ja: 'GitHub イシュー'
  },
  'auto.components.settings.CommitMessageAiPane.4f722a5f53': {
    ko: '사용자 지정 명령을 선택하는 커밋 메시지, PR 및 브랜치 이름 레시피에서 사용됩니다. 사용',
    zh: '由选择自定义命令的提交消息、拉取请求和分支名称配方使用。使用',
    ja: 'カスタムコマンドを選択するコミットメッセージ、PR、ブランチ名のレシピで使用されます。使用'
  },
  'auto.components.settings.AgentsPane.9bccf48906': {
    ko: '에이전트 위치',
    zh: '代理位置',
    ja: 'エージェントの場所'
  },
  'auto.components.skills.SkillsPage.38e0951c3a': {
    ko: '에이전트 스킬',
    zh: '代理技能',
    ja: 'エージェントのスキル'
  },
  'auto.components.sidebar.SidebarNav.e518f544b1': {
    ko: '감지된 에이전트 없음',
    zh: '未检测到代理',
    ja: 'エージェントが検出されません'
  },
  'auto.components.onboarding.OnboardingFlow.04ae28d8ca': {
    ko: '몇 시간 내내 보고 싶은 테마를 선택하세요.',
    zh: '选择你想盯着看几个小时的主题。',
    ja: '何時間も眺めていたくなるテーマを選んでください。'
  },
  'auto.components.GitLabItemDialog.e089f62594': {
    ko: 'MR !{{value0}}을(를) 병합했습니다.',
    zh: '合并 MR !{{value0}}',
    ja: 'MR をマージしました !{{value0}}'
  },
  'auto.components.right.sidebar.source.control.primary.action.3d5dccef0b': {
    ko: '커밋할 것이 없습니다. PR은 이미 병합되었습니다.',
    zh: '没有可提交的内容。PR 已合并。',
    ja: 'コミットするものはありません。PR はすでにマージされています。'
  },
  'auto.components.settings.integrations.search.16a486a49d': {
    ko: 'Linear에 연결해 이슈를 탐색하고 연결합니다.',
    zh: '连接 Linear 以浏览和链接议题。',
    ja: 'Linear に接続してイシューを参照し、リンクします。'
  },
  'menu.showTitlebarAppName': {
    ko: '제목 표시줄 앱 이름 표시',
    zh: '显示标题栏应用名称',
    ja: 'タイトルバーのアプリ名を表示'
  },
  'auto.App.e81217c1b7': {
    ko: '앱 이름 숨기기',
    zh: '隐藏应用名称',
    ja: 'アプリ名を非表示'
  },
  'auto.components.settings.ExperimentalPane.0277901cf7': {
    ko: '완료된 에이전트, 차단 질문, 읽지 않은 상태 및 작업 트리 생성 이벤트에 대한 스레드 작업 트리 피드가 있는 에이전트 항목을 왼쪽 사이드바에 추가합니다. 실험적 — 이벤트 모델과 UI가 변경될 수 있습니다.',
    zh: '将代理条目添加到左侧边栏，其中包含已完成代理、阻塞待办、未读状态和工作树创建事件的线程工作树提要。实验性——事件模型和 UI 可能会改变。',
    ja: '完了したエージェント、ブロック中の質問、未読状態、ワークツリー作成イベントのスレッドワークツリーフィード付きエージェント項目を左サイドバーに追加します。実験的 — イベントモデルと UI は変更される場合があります。'
  },
  'auto.lib.fix.checks.agent.launch.9f00d7df0c': {
    ko: '검사 프롬프트가 비어 있습니다. 소스 제어 AI 설정을 업데이트하세요.',
    zh: '检查提示为空。请更新源代码管理 AI 设置。',
    ja: 'チェック プロンプトが空です。ソース管理 AI 設定を更新してください。'
  },
  'auto.components.TaskPage.d0e3c8f933': {
    ko: '일치하는 GitHub 작업이 없습니다',
    zh: '没有匹配的 GitHub 工作项',
    ja: '一致する GitHub 作業がありません'
  },
  'auto.components.TaskPage.2af3ab5c58': {
    ko: 'Linear에서 열 팀을 하나 선택하세요',
    zh: '选择一个团队在 Linear 中打开',
    ja: 'Linear で開くチームを 1 つ選択'
  },
  'auto.components.TaskPage.8964184a8b': {
    ko: 'Linear 새로고침',
    zh: '刷新 Linear',
    ja: 'Linear を更新'
  },
  'auto.components.TaskPage.6775c05483': {
    ko: 'Linear 상태를 업데이트할 수 없습니다',
    zh: '无法更新 Linear 状态',
    ja: 'Linear の状態を更新できません'
  },
  'auto.components.TaskPage.25ff84769a': {
    ko: '이 Linear 컨텍스트와 일치하는 이슈가 없습니다.',
    zh: '没有议题与此 Linear 上下文匹配。',
    ja: 'この Linear コンテキストに一致するイシューはありません。'
  },
  'auto.components.settings.IntegrationsPane.33ae9730a8': {
    ko: 'Linear 액세스를 추가해 이슈를 탐색하고 연결합니다.',
    zh: '添加 Linear 访问以浏览和链接议题。',
    ja: 'Linear アクセスを追加してイシューを参照し、リンクします。'
  },
  'auto.components.GitHubItemDialog.3ab6ac0fc8': {
    ko: '선택한 GitHub 이슈 또는 PR을 미리보기하고 편집합니다.',
    zh: '预览并编辑选定的 GitHub 议题或拉取请求。',
    ja: '選択した GitHub イシューまたは PR をプレビュー・編集します。'
  },
  'auto.components.GitHubItemDialog.8c45901789': {
    ko: '리뷰어 요청 {{value0}}',
    zh: '请求评审人 {{value0}}',
    ja: 'レビュアーをリクエスト {{value0}}'
  },
  'auto.components.GitHubItemDialog.fedc09eeb9': {
    ko: '리뷰 요청 취소 {{value0}}',
    zh: '取消请求评审人 {{value0}}',
    ja: 'レビュアーのリクエストを取り消す {{value0}}'
  },
  'auto.components.TaskPage.be8cf68d9f': {
    ko: '이슈 보기',
    zh: '查看议题',
    ja: 'イシューを表示'
  },
  'auto.components.mobile.MobilePage.e17393c6a3': {
    ko: '전화 미리보기',
    zh: '手机预览',
    ja: 'スマートフォンプレビュー'
  },
  'auto.components.editor.EditorContent.e4b074749d': {
    ko: '머리말',
    zh: '前线事项',
    ja: 'フロントマター'
  },
  'auto.components.editor.MarkdownPreview.2b2b31382c': {
    ko: '머리말',
    zh: '前线事项',
    ja: 'フロントマター'
  },
  'auto.components.settings.IntegrationsPane.c0c8575e05': {
    ko: 'PR, 이슈 및 검사를 활성화하려면 GitHub CLI를 설치하세요.',
    zh: '安装 GitHub CLI 以启用拉取请求、议题和检查。',
    ja: 'GitHub CLI をインストールして PR、イシュー、チェックを有効にします。'
  },
  'auto.components.dashboard.DashboardAgentRow.92a7017987': {
    ko: '전송 중',
    zh: '发送',
    ja: '送信中'
  },
  'auto.components.github.pr.merge.state.bf5e4c6c92': {
    ko: '차단됨',
    zh: '已阻塞',
    ja: 'ブロック中'
  },
  'auto.components.sidebar.workspace.status.93ac840dcb': {
    ko: '차단됨',
    zh: '已阻塞',
    ja: 'ブロック中'
  },
  'auto.components.sidebar.workspace.status.6c1efa2cf8': {
    ko: '검토 중',
    zh: '评审中',
    ja: 'レビュー中'
  },
  'auto.components.sidebar.workspace.status.409528031f': {
    ko: '검토',
    zh: '评审',
    ja: 'レビュー'
  },
  'auto.components.UpdateCard.actionBadge': {
    ko: '작업',
    zh: '操作',
    ja: '操作'
  },
  'auto.components.settings.GitPane.b559bf9899': {
    ko: '예: feature',
    zh: '例如 feature',
    ja: '例: feature'
  },
  'auto.components.mobile.slides.TerminalSlide.985373052e': {
    ko: '휴대폰 모드로 전환',
    zh: '切换到手机模式',
    ja: 'スマートフォンモードに切り替え'
  },
  'auto.components.GitHubItemDialog.a341343303': {
    ko: '리뷰 댓글이 추가되었습니다.',
    zh: '已添加评审评论。',
    ja: 'レビューコメントを追加しました。'
  },
  // Port forwarding "Forward" is 転送, not the browser-navigation 進む.
  'auto.components.right.sidebar.PortsPanel.c9d106547a': { ja: '転送' },
  ...KO_KEY_OVERRIDES
}
