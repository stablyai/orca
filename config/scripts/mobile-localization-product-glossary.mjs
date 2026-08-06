export const REQUIRED_TARGET_TRANSLATIONS = new Set([
  'pullRequest.checks.running',
  'pullRequest.unresolvedComments.one',
  'pullRequest.unresolvedComments.other'
])

export const EXACT_LANGUAGE_NEUTRAL_KEYS = new Set([
  'mobileRichMarkdownEditor.h2',
  'terminalAccessoryKeyCatalog.del',
  'terminalAccessoryKeyCatalog.esc',
  'terminalAccessoryKeyCatalog.shiftPlus',
  'terminalAccessoryKeys.alt',
  'terminalAccessoryKeys.ctrl',
  'terminalAccessoryKeys.ins',
  'terminalAccessoryKeys.pgDn',
  'terminalAccessoryKeys.pgUp',
  'terminalAccessoryKeys.shift'
])

export const REVIEWED_KEY_TRANSLATIONS = new Map([
  ['connectionHealth.cannotConnect', { es: 'No se puede conectar' }],
  [
    'home.agent',
    {
      es: 'Tiempo de agentes',
      ja: 'エージェントの稼働時間',
      ko: '에이전트 시간',
      zh: '智能体用时'
    }
  ],
  [
    'home.agents',
    {
      es: 'Agentes iniciados',
      ja: '起動したエージェント',
      ko: '시작된 에이전트',
      zh: '已启动智能体'
    }
  ],
  [
    'home.pairingDescription',
    {
      es: 'Empareja Orca con tu computadora para consultar tus agentes, acceder a cualquier terminal y avanzar el trabajo desde tu teléfono.',
      ja: 'コンピュータ上の Orca とペアリングすると、エージェントの状況を確認し、任意のターミナルにアクセスして、スマートフォンから作業を進められます。',
      ko: '컴퓨터의 Orca와 페어링하여 에이전트 상태를 확인하고, 원하는 터미널에 접속하고, 휴대폰에서 작업을 진행하세요.',
      zh: '将手机与计算机上的 Orca 配对，即可查看智能体状态、进入任意终端，并通过手机推进工作。'
    }
  ],
  [
    'task.gitHubReportsMergeConflictsOpen',
    { es: 'GitHub informa de conflictos de fusión. Abre GitHub para continuar.' }
  ],
  ['task.viewOrder', { es: 'Orden de vista', ja: '表示順', ko: '보기 순서', zh: '视图顺序' }],
  [
    'task.rerunFailed',
    {
      es: 'Volver a ejecutar las comprobaciones fallidas',
      ja: '失敗したチェックを再実行',
      ko: '실패한 검사 다시 실행',
      zh: '重新运行失败的检查'
    }
  ],
  [
    'task.mergeRequests',
    {
      es: 'Merge Requests e incidencias por repositorio',
      ja: 'リポジトリごとの Merge Request と Issue',
      ko: '저장소별 Merge Request 및 이슈',
      zh: '按仓库显示 Merge Request 和议题'
    }
  ],
  ['task.mergePullRequestTitle', { es: 'Fusionar Pull Request' }],
  ['task.mergeMerge', { es: 'Fusionar Merge Request' }],
  ['task.noPipeline', { zh: '此 MR 没有运行任何流水线。' }],
  ['task.pipeline', { zh: '流水线' }],
  [
    'task.failedUpdateGitHubIssue',
    { ja: 'GitHub Issue の更新に失敗しました', zh: '更新 GitHub 议题失败' }
  ],
  ['workspaceListPickerOptions.server', { ko: '서버 순서' }],
  [
    'task.orderLinearOrder',
    {
      ja: '順序: {{linearOrderLabel}}',
      ko: '순서: {{linearOrderLabel}}',
      zh: '顺序：{{linearOrderLabel}}'
    }
  ],
  [
    'terminalAccessoryKeyCatalog.escape',
    { es: 'Tecla Esc', ja: 'Escapeキー', ko: 'Esc 키', zh: 'Esc 键' }
  ],
  ['terminalAccessoryKeyCatalog.interrupt', { es: 'Interrumpir terminal' }],
  ['terminalAccessoryKeyCatalog.enter', { ja: 'Enterキー', ko: 'Enter 키', zh: 'Enter 键' }],
  ['terminalAccessoryKeyCatalog.space', { ja: 'スペース', ko: '스페이스', zh: '空格键' }],
  ['customKeyModal.key', { es: 'Tecla', ja: 'キー', zh: '按键' }],
  ['customKeyModal.pick', { es: 'Elige una tecla', ja: 'キーを選択してください', zh: '选择按键' }],
  ['customKeyModal.eGBuild', { ko: '예: 빌드' }],
  [
    'authFailedBanner.re',
    { es: 'Volver a emparejar', ja: '再ペアリング', ko: '다시 페어링', zh: '重新配对' }
  ],
  [
    'voiceSettings.togglePress',
    {
      ko: '토글: 한 번 누르면 시작되고 다시 누르면 중지됩니다. 길게 누르기: 누르고 있는 동안 받아씁니다.'
    }
  ],
  [
    'mobileHostedReviewCreateIntent.force',
    {
      es: 'Haciendo push forzado con lease...',
      ja: 'リースを使用して強制的にプッシュします...',
      ko: '리스를 사용해 강제 푸시 중...',
      zh: '正在使用租约强制推送...'
    }
  ],
  [
    'mobileHostedReviewCreateIntent.pushing',
    {
      es: 'Haciendo push de commits...',
      ja: 'commits をプッシュしています...',
      ko: 'commits 푸시 중...',
      zh: '正在推送 commits...'
    }
  ],
  [
    'mobilePrCreate.push',
    {
      es: 'Haz push de la rama base antes de crear un {{reviewType}}.',
      ja: '{{reviewType}} を作成する前にベース ブランチをプッシュしてください。',
      ko: '{{reviewType}}을 생성하기 전에 기본 브랜치를 푸시하세요.',
      zh: '在创建 {{reviewType}} 之前推送基础分支。'
    }
  ],
  [
    'mobileSourceControlPrimaryAction.forcePushLease',
    {
      es: 'Haz un push forzado con lease para actualizar la rama remota.',
      ja: 'リモート ブランチを更新するには、リースを使用して強制的にプッシュします。',
      ko: '원격 브랜치를 업데이트하려면 리스를 사용해 강제 푸시하세요.',
      zh: '使用租约强制推送以更新远程分支。'
    }
  ],
  [
    'mobileSourceControlPrimaryAction.forcePushProgress',
    {
      es: 'Push forzado en curso.',
      ja: '強制プッシュが進行中です。',
      ko: '강제 푸시가 진행 중입니다.',
      zh: '正在进行强制推送。'
    }
  ],
  [
    'mobileSourceControlPrimaryAction.pullCommitCountCommit',
    {
      es: 'Haz pull de {{commitCount}} commit.',
      ja: '{{commitCount}} commit をプルします。',
      ko: '{{commitCount}}개 commit을 풀합니다.',
      zh: '拉取 {{commitCount}} commit。'
    }
  ],
  [
    'mobileSourceControlPrimaryAction.pullCommitCountCommits',
    {
      es: 'Haz pull de {{commitCount}} commits.',
      ja: '{{commitCount}} commits をプルします。',
      ko: '{{commitCount}}개 commits을 풀합니다.',
      zh: '拉取 {{commitCount}} commits。'
    }
  ],
  [
    'mobileSourceControlPrimaryAction.pushCommitCountCommit',
    {
      es: 'Haz push de {{commitCount}} commit.',
      ja: '{{commitCount}} commit をプッシュします。',
      ko: '{{commitCount}} commit을 푸시합니다.',
      zh: '推送 {{commitCount}} commit。'
    }
  ],
  [
    'mobileSourceControlPrimaryAction.pushCommitCountCommits',
    {
      es: 'Haz push de {{commitCount}} commits.',
      ja: '{{commitCount}} commits をプッシュします。',
      ko: '{{commitCount}} commits을 푸시합니다.',
      zh: '推送 {{commitCount}} commits。'
    }
  ],
  [
    'mobilePrComposeForm.pushCreateReview',
    {
      es: 'Hacer push y crear {{reviewType}}',
      ja: 'プッシュして {{reviewType}} を作成',
      ko: '푸시하고 {{reviewType}} 생성',
      zh: '推送并创建 {{reviewType}}'
    }
  ],
  [
    'mobilePrComposeForm.pushCreateDraft',
    {
      es: 'Hacer push y crear borrador de {{reviewType}}',
      ja: 'プッシュしてドラフト {{reviewType}} を作成',
      ko: '푸시하고 초안 {{reviewType}} 생성',
      zh: '推送并创建草稿 {{reviewType}}'
    }
  ],
  [
    'mobileOnboarding.notification',
    { ja: '通知設定を更新できませんでした。もう一度お試しください。' }
  ],
  ['mobileOnboarding.your', { ja: '選択内容を保存できませんでした。もう一度お試しください。' }]
])

export const PRODUCT_GLOSSARY = new Map([
  [
    'Sparse Checkout',
    {
      es: 'Checkout disperso',
      ja: 'スパースチェックアウト',
      ko: '스파스 체크아웃',
      zh: '稀疏检出'
    }
  ],
  [
    'Detecting Agents',
    {
      es: 'Detectando agentes',
      ja: 'エージェントを検出中',
      ko: '에이전트 감지 중',
      zh: '正在检测智能体'
    }
  ],
  [
    'Loading terminal',
    {
      es: 'Cargando terminal',
      ja: 'ターミナルを読み込み中',
      ko: '터미널 불러오는 중',
      zh: '正在加载终端'
    }
  ],
  [
    'Open source control',
    {
      es: 'Abrir control de código fuente',
      ja: 'ソース管理を開く',
      ko: '소스 제어 열기',
      zh: '打开源代码管理'
    }
  ],
  [
    '{{pipelineJobCount}} jobs',
    {
      es: '{{pipelineJobCount}} trabajos del pipeline',
      ja: '{{pipelineJobCount}} 件のジョブ',
      ko: '파이프라인 작업 {{pipelineJobCount}}개',
      zh: '{{pipelineJobCount}} 个作业'
    }
  ],
  [
    'No checks found.',
    {
      es: 'No se encontraron comprobaciones.',
      ja: 'チェックが見つかりませんでした。',
      ko: '검사를 찾을 수 없습니다.',
      zh: '未找到检查项。'
    }
  ],
  [
    'Invalid checks response',
    {
      es: 'Respuesta de comprobaciones no válida',
      ja: 'チェックの応答が無効です',
      ko: '잘못된 검사 응답',
      zh: '检查响应无效'
    }
  ],
  [
    'Order Linear Issues',
    {
      es: 'Ordenar incidencias de Linear',
      ja: 'Linear の課題を並べ替える',
      ko: 'Linear 이슈 정렬',
      zh: '排序 Linear 议题'
    }
  ],
  [
    'Group Linear Issues',
    {
      es: 'Agrupar incidencias de Linear',
      ja: 'Linear の課題をグループ化',
      ko: 'Linear 이슈 그룹화',
      zh: '对 Linear 议题分组'
    }
  ],
  [
    'No states available',
    {
      es: 'No hay estados disponibles',
      ja: '利用可能なステータスがありません',
      ko: '사용 가능한 상태가 없습니다',
      zh: '没有可用的状态'
    }
  ],
  ['Body', { es: 'Texto normal', ja: '本文', ko: '본문', zh: '正文' }],
  ['SPEECH MODEL', { es: 'MODELO DE VOZ', ja: '音声モデル', ko: '음성 모델', zh: '语音模型' }],
  ['Open a shell', { es: 'Abrir un shell', ja: 'シェルを開く', ko: '셸 열기', zh: '打开 shell' }],
  [
    'Save terminal artifact',
    {
      es: 'Guardar artefacto de terminal',
      ja: 'ターミナルの成果物を保存',
      ko: '터미널 아티팩트 저장',
      zh: '保存终端产物'
    }
  ],
  [
    'Push & Create PR',
    {
      es: 'Hacer push y crear PR',
      ja: 'プッシュして PR を作成',
      ko: '푸시 및 PR 생성',
      zh: '推送并创建 PR'
    }
  ],
  [
    'Commit & Push',
    { es: 'Commit y push', ja: 'Commit とプッシュ', ko: 'Commit 및 푸시', zh: 'Commit 并推送' }
  ],
  [
    'Nothing to pull',
    {
      es: 'No hay cambios para pull',
      ja: 'プルするものはありません',
      ko: '풀할 내용이 없습니다',
      zh: '没有可拉取的内容'
    }
  ],
  [
    'Pull ({{behindCommitCount}})',
    {
      es: 'Hacer pull ({{behindCommitCount}})',
      ja: 'プル ({{behindCommitCount}})',
      ko: '풀 ({{behindCommitCount}})',
      zh: '拉取 ({{behindCommitCount}})'
    }
  ],
  [
    'Nothing to push',
    {
      es: 'No hay commits para push',
      ja: 'プッシュするものはありません',
      ko: '푸시할 내용이 없습니다',
      zh: '没有可推送的内容'
    }
  ],
  [
    'Push ({{aheadCommitCount}})',
    {
      es: 'Hacer push ({{aheadCommitCount}})',
      ja: 'プッシュ ({{aheadCommitCount}})',
      ko: '푸시 ({{aheadCommitCount}})',
      zh: '推送 ({{aheadCommitCount}})'
    }
  ],
  [
    'Pull {{behindCommitCount}}, push {{aheadCommitCount}}.',
    {
      es: 'Pull: {{behindCommitCount}}; push: {{aheadCommitCount}}.',
      ja: '{{behindCommitCount}} 件をプルし、{{aheadCommitCount}} 件をプッシュします。',
      ko: '{{behindCommitCount}}개를 풀하고 {{aheadCommitCount}}개를 푸시합니다.',
      zh: '拉取 {{behindCommitCount}}，推送 {{aheadCommitCount}}。'
    }
  ],
  [
    '{{failingCheckCount}} failing check',
    {
      es: '{{failingCheckCount}} comprobación fallida',
      ja: '失敗したチェック {{failingCheckCount}} 件',
      ko: '실패한 검사 {{failingCheckCount}}개',
      zh: '{{failingCheckCount}} 项检查失败'
    }
  ],
  [
    'Failed to load check details',
    {
      es: 'No se pudieron cargar los detalles de la comprobación',
      ja: 'チェックの詳細を読み込めませんでした',
      ko: '검사 세부 정보를 불러오지 못했습니다.',
      zh: '无法加载检查详细信息'
    }
  ]
])
