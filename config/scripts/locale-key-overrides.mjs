// Key-specific overrides from high-visibility UI audit (P0/P1/P2).
// Why: some fixes depend on full key context, not English value alone.
export const LOCALE_KEY_OVERRIDES = {
  'menu.reportCrash': { ko: '크래시 신고...', zh: '报告崩溃...', ja: 'クラッシュを報告...' },
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
  'worktreeJumpPalette.matchLabel.issue': { ko: '이슈', zh: '议题', ja: 'イシュー' },
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
    ko: '통합',
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
    ko: '티켓 복사',
    zh: '复制工单',
    ja: 'チケットをコピー'
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
    ja: 'プルリクエストがマージされました'
  },
  'auto.components.PullRequestPage.c57873d721': {
    ko: 'PR이 병합되었습니다',
    zh: '拉取请求已合并',
    ja: 'プルリクエストがマージされました'
  },
  'auto.components.TaskPage.a161925adc': {
    ko: 'PR이 병합되었습니다',
    zh: '拉取请求已合并',
    ja: 'プルリクエストがマージされました'
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
  }
}
