const AGENT_CATALOG_PREFIX = 'auto.lib.agent.catalog.'
const OPEN_IN_APP_CATALOG_PREFIX = 'auto.lib.open.in.app.catalog.'

// Why: product names and agent labels stay Latin — MT reads them as common words (Codex→copy, Gemini→zodiac).
export const ENGLISH_ONLY_KEY_PREFIXES = [AGENT_CATALOG_PREFIX, OPEN_IN_APP_CATALOG_PREFIX]

export const NEVER_TRANSLATE_VALUES = new Set([
  'Aider',
  'Amp',
  'Antigravity',
  'Auggie',
  'Autohand Code',
  'Charm',
  'Claude',
  'Claude Agent Teams',
  'Cline',
  'Codebuff',
  'Codex',
  'Command Code',
  'Continue',
  'Cursor',
  'Droid',
  'Gemini',
  'GitHub Copilot',
  'Goose',
  'Grok',
  'Hermes',
  'Kilocode',
  'Kimi',
  'Kiro',
  'Linear',
  'Mistral Vibe',
  'OMP',
  'OpenClaude',
  'OpenClaw',
  'OpenCode',
  'Orca',
  'Pi',
  'PostHog',
  'Qwen Code',
  'Rovo Dev',
  'VS Code',
  'Zed',
  'codex',
  'gemini',
  'claude',
  'gh',
  'idle',
  'anthropic'
])

// Why: settings search keywords are short synonyms — MT often returns wrong or awkward forms.
export const SEARCH_KEYWORD_OVERRIDES = {
  ko: {
    dark: '다크',
    light: '라이트',
    font: '폰트',
    theme: '테마',
    zoom: '확대',
    scale: '배율',
    proxy: '프록시',
    terminal: '터미널',
    workspace: '워크스페이스',
    folder: '폴더',
    language: '언어',
    locale: '로케일',
    translation: '번역',
    agent: '에이전트',
    agents: '에이전트',
    default: '기본값',
    command: '명령',
    override: '재정의',
    install: '설치',
    installed: '설치됨',
    detected: '감지됨',
    enable: '활성화',
    disable: '비활성화',
    hide: '숨기기',
    show: '표시',
    awake: '깨어 있음',
    sleep: '절전',
    power: '전원',
    hooks: '훅',
    status: '상태',
    waiting: '대기',
    done: '완료',
    tab: '탭',
    title: '제목',
    prompt: '프롬프트',
    rename: '이름 변경',
    session: '세션',
    location: '위치',
    detect: '감지',
    path: '경로',
    cli: 'CLI',
    'shell command': '셸 명령',
    'open in': '열기',
    delete: '삭제',
    confirm: '확인',
    update: '업데이트',
    cache: '캐시',
    timer: '타이머',
    search: '검색'
  },
  zh: {
    dark: '深色',
    light: '浅色',
    font: '字体',
    theme: '主题',
    zoom: '缩放',
    scale: '比例',
    proxy: '代理',
    terminal: '终端',
    workspace: '工作区',
    folder: '文件夹',
    language: '语言',
    locale: '区域设置',
    translation: '翻译',
    agent: '代理',
    agents: '代理',
    default: '默认',
    command: '命令',
    override: '覆盖',
    install: '安装',
    installed: '已安装',
    detected: '已检测',
    enable: '启用',
    disable: '禁用',
    hide: '隐藏',
    show: '显示',
    awake: '唤醒',
    sleep: '睡眠',
    power: '电源',
    hooks: '钩子',
    status: '状态',
    waiting: '等待',
    done: '完成',
    tab: '标签页',
    title: '标题',
    prompt: '提示词',
    rename: '重命名',
    session: '会话',
    location: '位置',
    detect: '检测',
    path: '路径',
    cli: 'CLI',
    'shell command': 'Shell 命令',
    'open in': '打开方式',
    delete: '删除',
    confirm: '确认',
    update: '更新',
    cache: '缓存',
    timer: '计时器',
    search: '搜索'
  },
  ja: {
    dark: 'ダーク',
    light: 'ライト',
    font: 'フォント',
    theme: 'テーマ',
    zoom: 'ズーム',
    scale: '倍率',
    proxy: 'プロキシ',
    terminal: 'ターミナル',
    workspace: 'ワークスペース',
    folder: 'フォルダ',
    language: '言語',
    locale: 'ロケール',
    translation: '翻訳',
    agent: 'エージェント',
    agents: 'エージェント',
    default: 'デフォルト',
    command: 'コマンド',
    override: '上書き',
    install: 'インストール',
    installed: 'インストール済み',
    detected: '検出済み',
    enable: '有効化',
    disable: '無効化',
    hide: '非表示',
    show: '表示',
    awake: '起きたまま',
    sleep: 'スリープ',
    power: '電源',
    hooks: 'フック',
    status: '状態',
    waiting: '待機',
    done: '完了',
    tab: 'タブ',
    title: 'タイトル',
    prompt: 'プロンプト',
    rename: '名前変更',
    session: 'セッション',
    location: '場所',
    detect: '検出',
    path: 'パス',
    cli: 'CLI',
    'shell command': 'シェルコマンド',
    'open in': '開く',
    delete: '削除',
    confirm: '確認',
    update: '更新',
    cache: 'キャッシュ',
    timer: 'タイマー',
    search: '検索'
  }
}

export const LOCALE_VALUE_OVERRIDES = {
  ko: {
    Save: '저장',
    Close: '닫기',
    Connect: '연결',
    Edit: '편집',
    Add: '추가',
    Create: '생성',
    Delete: '삭제',
    Install: '설치',
    Remove: '제거',
    Refresh: '새로고침',
    Reset: '재설정',
    Enable: '활성화',
    Disabled: '비활성',
    Ready: '준비됨',
    Select: '선택',
    Clear: '지우기',
    Back: '뒤로',
    Reopen: '다시 열기',
    Closed: '닫힘',
    Agents: '에이전트',
    agents: '에이전트',
    orchestration: '오케스트레이션',
    conflict: '충돌',
    Disconnect: '연결 해제',
    Cancel: '취소',
    Copy: '복사',
    Done: '완료',
    Next: '다음',
    Beta: '베타',
    Dismiss: '닫기',
    Optional: '선택 사항',
    Ports: '포트',
    Active: '활성',
    'Dismiss agent': '에이전트 닫기',
    'Codex Usage': 'Codex 사용량',
    'Claude Usage': 'Claude 사용량',
    'Gemini Usage': 'Gemini 사용량',
    'Force Delete Branch': '브랜치 강제 삭제',
    'Time agents worked': '에이전트 작업 시간',
    PR: 'PR',
    Installed: '설치됨',
    'Not installed': '설치되지 않음',
    Checking: '확인 중',
    'Checking...': '확인 중...',
    Connected: '연결됨',
    Search: '검색',
    'Search...': '검색...'
  },
  zh: {
    Dismiss: '关闭',
    Optional: '可选',
    Ports: '端口',
    Active: '当前',
    'Dismiss agent': '关闭代理',
    'Codex Usage': 'Codex 使用情况',
    'Claude Usage': 'Claude 使用情况',
    'Gemini Usage': 'Gemini 使用情况',
    'Force Delete Branch': '强制删除分支',
    'Time agents worked': '代理工作时间',
    PR: 'PR',
    Custom: '自定义',
    'Terminal 1': '终端 1',
    Starter: '入门版',
    Turns: '轮次',
    'Recent sessions': '最近的会话',
    Installed: '已安装',
    'Not installed': '未安装',
    Checking: '检查中',
    'Checking...': '检查中...',
    Connected: '已连接',
    Search: '搜索',
    'Search...': '搜索...'
  },
  ja: {
    Dismiss: '閉じる',
    Optional: '任意',
    Ports: 'ポート',
    Active: 'アクティブ',
    'Dismiss agent': 'エージェントを閉じる',
    'Codex Usage': 'Codex 使用量',
    'Claude Usage': 'Claude 使用量',
    'Gemini Usage': 'Gemini 使用量',
    'Force Delete Branch': 'ブランチを強制削除',
    'Time agents worked': 'エージェント作業時間',
    PR: 'PR',
    Custom: 'カスタム',
    'Terminal 1': 'ターミナル 1',
    Starter: 'スターター',
    Turns: 'ターン',
    'Recent sessions': '最近のセッション',
    Installed: 'インストール済み',
    'Not installed': '未インストール',
    Checking: '確認中',
    'Checking...': '確認中...',
    Connected: '接続済み',
    Search: '検索',
    'Search...': '検索...'
  }
}

export const BRAND_MISTRANSLATIONS = {
  ko: {
    Codex: ['사본', '코덱스'],
    Gemini: ['쌍둥이자리'],
    Claude: ['클로드'],
    Grok: ['그록'],
    Orca: ['오르카', '범고래'],
    Cursor: ['커서'],
    OpenCode: ['오픈코드'],
    OpenClaw: ['오픈클로'],
    OpenClaude: ['오픈클로드'],
    Antigravity: ['반중력'],
    Continue: ['계속하다'],
    Charm: ['매력'],
    Goose: ['거위'],
    Pi: ['파이'],
    'GitHub Copilot': ['GitHub 코파일럿', '코파일럿']
  },
  zh: {
    Codex: ['法典'],
    Gemini: ['双子座'],
    Claude: ['克洛德', '克劳德'],
    Grok: ['格罗克'],
    Orca: ['虎鲸', '逆戟鲸'],
    Cursor: ['光标'],
    OpenCode: ['开放代码'],
    OpenClaw: ['开爪'],
    OpenClaude: ['开放克劳德'],
    Antigravity: ['反重力'],
    Continue: ['继续'],
    Charm: ['魅力'],
    Goose: ['鹅'],
    Pi: ['圆周率'],
    Droid: ['机器人'],
    'GitHub Copilot': ['GitHub 副驾驶', '副驾驶']
  },
  ja: {
    Codex: ['法典', 'コーデックス'],
    Gemini: ['双子座'],
    Claude: ['クロード'],
    Grok: ['グロック'],
    Orca: ['シャチ', '逆戟鲸', 'オルカ'],
    Cursor: ['カーソル'],
    OpenCode: ['オープンコード', 'オープン・コード'],
    OpenClaw: ['オープンクロー'],
    OpenClaude: ['オープンクロード'],
    Antigravity: ['反重力'],
    Continue: ['続ける', '続行'],
    Charm: ['魅力'],
    Goose: ['ガチョウ', '雁'],
    Pi: ['円周率'],
    Droid: ['ロボット', 'ドロイド'],
    'GitHub Copilot': ['GitHub コパイロット', 'コパイロット']
  }
}

export const LOCALE_PHRASE_FIXES = {
  ko: [
    { pattern: /해고하다/g, replacement: '닫기', whenEnIncludes: 'Dismiss' },
    { pattern: /선택 과목/g, replacement: '선택 사항', whenEnIncludes: 'Optional' },
    { pattern: /상담원/g, replacement: '에이전트', whenEnIncludes: 'agent' },
    { pattern: /상담사/g, replacement: '에이전트', whenEnIncludes: 'agent' },
    { pattern: /지점/g, replacement: '브랜치', whenEnIncludes: 'ranch' },
    { pattern: /분기/g, replacement: '브랜치', whenEnIncludes: 'ranch' },
    { pattern: /나뭇가지/g, replacement: '브랜치', whenEnIncludes: 'ranch' },
    { pattern: /홍보/g, replacement: 'PR', whenEnIncludes: 'PR' },
    { pattern: /선형/g, replacement: 'Linear', whenEnIncludes: 'Linear' },
    { pattern: /관현악법/g, replacement: '오케스트레이션', whenEnIncludes: 'Orchestration' },
    { pattern: /자치령 대표/g, replacement: '에이전트', whenEnIncludes: 'Agents' },
    { pattern: /찾다\.\.\./g, replacement: '검색...', whenEnIncludes: 'Search' },
    { pattern: /찾다/g, replacement: '검색', whenEnIncludes: 'Search' },
    { pattern: /구하다/g, replacement: '저장', whenEnIncludes: 'Save' },
    { pattern: /설치하다/g, replacement: '설치', whenEnIncludes: 'Install' },
    { pattern: /장애가 있는/g, replacement: '비활성', whenEnIncludes: 'Disabled' },
    { pattern: /준비가 된/g, replacement: '준비됨', whenEnIncludes: 'Ready' },
    { pattern: /다시 놓기/g, replacement: '재설정', whenEnIncludes: 'Reset' },
    { pattern: /새로 고치다/g, replacement: '새로고침', whenEnIncludes: 'Refresh' },
    { pattern: /분명한/g, replacement: '지우기', whenEnIncludes: 'Clear' },
    { pattern: /할 수 있게 하다/g, replacement: '활성화', whenEnIncludes: 'Enable' },
    { pattern: /갈등/g, replacement: '충돌', whenEnIncludes: 'conflict' }
  ],
  zh: [
    { pattern: /客服人员/g, replacement: '代理', whenEnIncludes: 'agent' },
    { pattern: /会议/g, replacement: '会话', whenEnIncludes: 'session' },
    { pattern: /港口/g, replacement: '端口', whenEnIncludes: 'ort' },
    { pattern: /公关/g, replacement: 'PR', whenEnIncludes: 'PR' },
    { pattern: /虎鲸:\/\//g, replacement: 'orca://', whenEnIncludes: 'orca://' },
    { pattern: /代理商/g, replacement: '代理', whenEnIncludes: 'agent' },
    { pattern: /智能体/g, replacement: '代理', whenEnIncludes: 'agent' },
    { pattern: /分支机构/g, replacement: '分支', whenEnIncludes: 'ranch' }
  ],
  ja: [
    { pattern: /解雇/g, replacement: '閉じる', whenEnIncludes: 'Dismiss' },
    { pattern: /却下/g, replacement: '閉じる', whenEnIncludes: 'Dismiss' },
    { pattern: /代理人/g, replacement: 'エージェント', whenEnIncludes: 'agent' },
    { pattern: /支店/g, replacement: 'ブランチ', whenEnIncludes: 'ranch' },
    { pattern: /港(?!口)/g, replacement: 'ポート', whenEnIncludes: 'ort' },
    { pattern: /会議/g, replacement: 'セッション', whenEnIncludes: 'session' },
    { pattern: /広報/g, replacement: 'PR', whenEnIncludes: 'PR' },
    { pattern: /端末/g, replacement: 'ターミナル', whenEnIncludes: 'erminal' },
    { pattern: /シャチ:\/\//g, replacement: 'orca://', whenEnIncludes: 'orca://' }
  ]
}

export const NATIVE_PICKER_LABELS = {
  zh: { chinese: '中文（简体）', korean: '한국어', japanese: '日本語' },
  ko: { chinese: '中文（简体）', korean: '한국어', japanese: '日本語' },
  ja: { chinese: '中文（简体）', korean: '한국어', japanese: '日本語' }
}

export function isEnglishOnlyKey(key) {
  return ENGLISH_ONLY_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
}

export function shouldPreserveEnglishValue(enValue, key = '') {
  if (!enValue?.trim()) {
    return true
  }
  if (/^https?:\/\//.test(enValue) || enValue.startsWith('orca://')) {
    return true
  }
  if (isEnglishOnlyKey(key)) {
    return true
  }
  return NEVER_TRANSLATE_VALUES.has(enValue)
}

function applyBrandMistranslationFixes(enValue, localeValue, locale) {
  let result = localeValue
  const mistranslations = BRAND_MISTRANSLATIONS[locale] ?? {}

  for (const [brand, wrongForms] of Object.entries(mistranslations)) {
    if (!enValue.includes(brand)) {
      continue
    }
    if (result.includes(brand)) {
      continue
    }
    for (const wrong of wrongForms) {
      if (!result.includes(wrong)) {
        continue
      }
      // Why: "Copy identifier" legitimately uses 사본/复制 — only swap when English names the brand.
      if (brand === 'Codex' && /\bCopy\b/i.test(enValue)) {
        continue
      }
      result = result.replaceAll(wrong, brand)
    }
  }

  return result
}

function applyPhraseFixes(enValue, localeValue, locale) {
  let result = localeValue
  for (const fix of LOCALE_PHRASE_FIXES[locale] ?? []) {
    if (!enValue.toLowerCase().includes(fix.whenEnIncludes.toLowerCase())) {
      continue
    }
    result = result.replace(fix.pattern, fix.replacement)
  }
  return result
}

export function repairTranslatedValue({ key, enValue, localeValue, locale }) {
  if (shouldPreserveEnglishValue(enValue, key)) {
    return enValue
  }

  const override = LOCALE_VALUE_OVERRIDES[locale]?.[enValue]
  if (override) {
    return override
  }

  if (key.includes('.search.')) {
    const searchOverride = SEARCH_KEYWORD_OVERRIDES[locale]?.[enValue]
    if (searchOverride) {
      return searchOverride
    }
  }

  let result = localeValue
  result = applyBrandMistranslationFixes(enValue, result, locale)
  result = applyPhraseFixes(enValue, result, locale)

  if (enValue.includes('orca://')) {
    result = result.replace(/虎鲸:\/\//g, 'orca://')
  }

  if (enValue === 'Orca' || enValue.startsWith('Orca ')) {
    result = result
      .replaceAll('虎鲸', 'Orca')
      .replaceAll('逆戟鲸', 'Orca')
      .replaceAll('シャチ', 'Orca')
  }

  if (enValue.includes('orca://')) {
    result = result.replace(/シャチ:\/\//g, 'orca://')
  }

  return result
}

export function collectStringLeaves(value, prefix = '', leaves = []) {
  if (typeof value === 'string') {
    leaves.push({ key: prefix, value })
    return leaves
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return leaves
  }
  for (const [key, child] of Object.entries(value)) {
    collectStringLeaves(child, prefix ? `${prefix}.${key}` : key, leaves)
  }
  return leaves
}

export function setLeaf(catalog, key, translatedValue) {
  const parts = key.split('.')
  let cursor = catalog
  for (let index = 0; index < parts.length - 1; index += 1) {
    cursor = cursor[parts[index]]
  }
  cursor[parts.at(-1)] = translatedValue
}

export function repairCatalog(enCatalog, localeCatalog, locale) {
  const leaves = collectStringLeaves(enCatalog)
  let repaired = 0

  for (const leaf of leaves) {
    const current = leaf.key.split('.').reduce((cursor, part) => cursor?.[part], localeCatalog)
    const next = repairTranslatedValue({
      key: leaf.key,
      enValue: leaf.value,
      localeValue: current,
      locale
    })
    if (next !== current) {
      setLeaf(localeCatalog, leaf.key, next)
      repaired += 1
    }
  }

  if (localeCatalog.settings?.appearance?.language) {
    for (const [labelKey, label] of Object.entries(NATIVE_PICKER_LABELS[locale] ?? {})) {
      if (localeCatalog.settings.appearance.language[labelKey] !== label) {
        localeCatalog.settings.appearance.language[labelKey] = label
        repaired += 1
      }
    }
  }

  if (localeCatalog.menu) {
    if (locale === 'zh') {
      if (localeCatalog.menu.exploreOrca !== '探索 Orca') {
        localeCatalog.menu.exploreOrca = '探索 Orca'
        repaired += 1
      }
      if (localeCatalog.menu.gettingStarted !== 'Orca 入门') {
        localeCatalog.menu.gettingStarted = 'Orca 入门'
        repaired += 1
      }
    }
    if (locale === 'ko') {
      if (localeCatalog.menu.exploreOrca !== 'Orca 둘러보기') {
        localeCatalog.menu.exploreOrca = 'Orca 둘러보기'
        repaired += 1
      }
      if (localeCatalog.menu.gettingStarted !== 'Orca 시작하기') {
        localeCatalog.menu.gettingStarted = 'Orca 시작하기'
        repaired += 1
      }
    }
  }

  return repaired
}

export function repairCacheMap(cache, locale) {
  let repaired = 0
  for (const [enValue, translated] of cache.entries()) {
    const next = shouldPreserveEnglishValue(enValue)
      ? enValue
      : repairTranslatedValue({
          key: '',
          enValue,
          localeValue: translated,
          locale
        })
    if (next !== translated) {
      cache.set(enValue, next)
      repaired += 1
    }
  }
  return repaired
}
