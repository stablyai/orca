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
  'claude'
])

export const LOCALE_VALUE_OVERRIDES = {
  ko: {
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
    PR: 'PR'
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
    'Recent sessions': '最近的会话'
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
  }
}

export const LOCALE_PHRASE_FIXES = {
  ko: [
    { pattern: /해고하다/g, replacement: '닫기', whenEnIncludes: 'Dismiss' },
    { pattern: /선택 과목/g, replacement: '선택 사항', whenEnIncludes: 'Optional' },
    { pattern: /상담원/g, replacement: '에이전트', whenEnIncludes: 'agent' },
    { pattern: /상담사/g, replacement: '에이전트', whenEnIncludes: 'agent' },
    { pattern: /지점/g, replacement: '브랜치', whenEnIncludes: 'ranch' },
    { pattern: /분기/g, replacement: '브랜치', whenEnIncludes: 'ranch' }
  ],
  zh: [
    { pattern: /客服人员/g, replacement: '代理', whenEnIncludes: 'agent' },
    { pattern: /会议/g, replacement: '会话', whenEnIncludes: 'session' },
    { pattern: /港口/g, replacement: '端口', whenEnIncludes: 'ort' },
    { pattern: /公关/g, replacement: 'PR', whenEnIncludes: 'PR' },
    { pattern: /虎鲸:\/\//g, replacement: 'orca://', whenEnIncludes: 'orca://' }
  ]
}

export const NATIVE_PICKER_LABELS = {
  zh: { chinese: '中文（简体）', korean: '한국어' },
  ko: { chinese: '中文（简体）', korean: '한국어' }
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

  let result = localeValue
  result = applyBrandMistranslationFixes(enValue, result, locale)
  result = applyPhraseFixes(enValue, result, locale)

  if (enValue.includes('orca://')) {
    result = result.replace(/虎鲸:\/\//g, 'orca://')
  }

  if (enValue === 'Orca' || enValue.startsWith('Orca ')) {
    result = result.replaceAll('虎鲸', 'Orca').replaceAll('逆戟鲸', 'Orca')
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
