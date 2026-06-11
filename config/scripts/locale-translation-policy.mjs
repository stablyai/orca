import { LOCALE_KEY_OVERRIDES } from './locale-key-overrides.mjs'
import { LOCALE_PHRASE_FIXES } from './locale-phrase-fixes.mjs'
import { SEARCH_KEYWORD_OVERRIDES } from './locale-search-keyword-overrides.mjs'
import { LOCALE_VALUE_OVERRIDES } from './locale-value-overrides.mjs'

export { LOCALE_KEY_OVERRIDES } from './locale-key-overrides.mjs'
export { LOCALE_PHRASE_FIXES } from './locale-phrase-fixes.mjs'
export { SEARCH_KEYWORD_OVERRIDES } from './locale-search-keyword-overrides.mjs'
export { LOCALE_VALUE_OVERRIDES } from './locale-value-overrides.mjs'

const AGENT_CATALOG_PREFIX = 'auto.lib.agent.catalog.'
const OPEN_IN_APP_CATALOG_PREFIX = 'auto.lib.open.in.app.catalog.'

// Why: product names and agent labels stay Latin — MT reads them as common words (Codex→copy, Gemini→zodiac).
export const ENGLISH_ONLY_KEY_PREFIXES = [AGENT_CATALOG_PREFIX, OPEN_IN_APP_CATALOG_PREFIX]

export const NEVER_TRANSLATE_VALUES = new Set([
  'Agent',
  'Agents',
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
  'Repo',
  'Repos',
  'Rovo Dev',
  'Commit',
  'Commits',
  'Markdown',
  'Terminal',
  'Terminals',
  'VS Code',
  'Zed',
  'agent',
  'agents',
  'codex',
  'commit',
  'commits',
  'gemini',
  'claude',
  'markdown',
  'repo',
  'repos',
  'terminal',
  'terminals',
  'gh',
  'idle',
  'anthropic',
  'Discord',
  'WSL',
  'wsl',
  'darwin',
  'Nautilus',
  'GitHub',
  'no_proxy',
  'Beta'
])

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
    'GitHub Copilot': ['GitHub 코파일럿', '코파일럿'],
    Discord: ['디스코드'],
    Linear: ['선형'],
    Agent: ['에이전트'],
    Agents: ['에이전트'],
    agent: ['에이전트'],
    agents: ['에이전트'],
    Commit: ['커밋'],
    Commits: ['커밋'],
    commit: ['커밋'],
    commits: ['커밋'],
    Markdown: ['마크다운', '가격 인하'],
    markdown: ['마크다운', '가격 인하'],
    Repo: ['저장소', '레포'],
    Repos: ['저장소', '레포'],
    repo: ['저장소', '레포'],
    repos: ['저장소', '레포'],
    Terminal: ['터미널'],
    Terminals: ['터미널'],
    terminal: ['터미널'],
    terminals: ['터미널']
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
    'GitHub Copilot': ['GitHub 副驾驶', '副驾驶'],
    Linear: ['线性', '线形'],
    Jira: ['吉拉'],
    Agent: ['代理', '智能体'],
    Agents: ['代理', '智能体'],
    agent: ['代理', '智能体'],
    agents: ['代理', '智能体'],
    Commit: ['提交'],
    Commits: ['提交'],
    commit: ['提交'],
    commits: ['提交'],
    Markdown: ['降价'],
    markdown: ['降价'],
    Repo: ['存储库', '仓库', '回购协议', '回购'],
    Repos: ['存储库', '仓库', '回购协议', '回购'],
    repo: ['存储库', '仓库', '回购协议', '回购'],
    repos: ['存储库', '仓库', '回购协议', '回购'],
    Terminal: ['终端', '端子'],
    Terminals: ['终端', '端子'],
    terminal: ['终端', '端子'],
    terminals: ['终端', '端子']
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
    'GitHub Copilot': ['GitHub コパイロット', 'コパイロット'],
    Discord: ['不和'],
    Linear: ['線形'],
    Agent: ['エージェント'],
    Agents: ['エージェント'],
    agent: ['エージェント'],
    agents: ['エージェント'],
    Commit: ['コミット'],
    Commits: ['コミット'],
    commit: ['コミット'],
    commits: ['コミット'],
    Markdown: ['マークダウン'],
    markdown: ['マークダウン'],
    Repo: ['リポジトリ', 'リポ'],
    Repos: ['リポジトリ', 'リポ'],
    repo: ['リポジトリ', 'リポ'],
    repos: ['リポジトリ', 'リポ'],
    Terminal: ['ターミナル', '端子'],
    Terminals: ['ターミナル', '端子'],
    terminal: ['ターミナル', '端子'],
    terminals: ['ターミナル', '端子']
  },
  es: {
    Codex: ['códice', 'Códice'],
    Gemini: ['Géminis'],
    Claude: ['claudia', 'Claudia'],
    Orca: ['orca', 'Orcas', 'orcas'],
    OpenCode: ['código abierto', 'Código abierto'],
    OpenClaude: ['Openclaude'],
    Antigravity: ['antigravedad', 'Antigravedad'],
    'GitHub Copilot': ['Copiloto de GitHub'],
    Discord: ['discordia'],
    Linear: ['lineal', 'Lineal'],
    Jira: ['jira'],
    Agent: ['Agente', 'agente'],
    Agents: ['Agentes', 'agentes'],
    agent: ['agente'],
    agents: ['agentes'],
    Commit: ['Confirmación', 'confirmación', 'Confirmar', 'Comprometerse'],
    Commits: ['Confirmaciones', 'confirmaciones', 'Compromisos', 'compromisos', 'Se compromete'],
    commit: ['confirmación', 'confirmar', 'comprometerse', 'compromiso'],
    commits: ['confirmaciones', 'compromisos'],
    Markdown: ['Reducción', 'reducción', 'Rebaja', 'rebaja', 'rebajas'],
    markdown: ['reducción', 'rebaja', 'rebajas'],
    Repo: ['Repositorio', 'repositorio'],
    Repos: ['Repositorios', 'repositorios'],
    repo: ['repositorio'],
    repos: ['repositorios']
  }
}

export const NATIVE_PICKER_LABELS = {
  zh: { chinese: '中文（简体）', korean: '한국어', japanese: '日本語', spanish: 'Español' },
  ko: { chinese: '中文（简体）', korean: '한국어', japanese: '日本語', spanish: 'Español' },
  ja: { chinese: '中文（简体）', korean: '한국어', japanese: '日本語', spanish: 'Español' },
  es: { chinese: '中文（简体）', korean: '한국어', japanese: '日本語', spanish: 'Español' }
}

const CJK_LATIN_SPACED_TERMS = [
  'Terminal',
  'Terminals',
  'terminal',
  'terminals',
  'Agents',
  'Agent',
  'agents',
  'agent',
  'Markdown',
  'markdown',
  'Repos',
  'Repo',
  'repos',
  'repo',
  'Commits',
  'Commit',
  'commits',
  'commit',
  'Linear',
  'Claude',
  'Codex',
  'Orca',
  'Cursor'
]

const CJK_LATIN_SPACED_TERM_PATTERN = CJK_LATIN_SPACED_TERMS.join('|')

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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function includesPreservedLatinTerm(value, term) {
  if (!/^[A-Za-z_]+$/.test(term)) {
    return value.includes(term)
  }
  return new RegExp(`(^|[^A-Za-z_])${escapeRegExp(term)}($|[^A-Za-z_])`).test(value)
}

function applyBrandMistranslationFixes(enValue, localeValue, locale) {
  let result = localeValue
  const mistranslations = BRAND_MISTRANSLATIONS[locale] ?? {}

  for (const [brand, wrongForms] of Object.entries(mistranslations).sort(
    ([left], [right]) => right.length - left.length
  )) {
    if (!enValue.includes(brand)) {
      continue
    }
    if (includesPreservedLatinTerm(result, brand)) {
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

function applyCjkLatinTermSpacing(localeValue, locale) {
  // Why: CJK UI copy should keep protected Latin workflow terms readable when MT glues them to native text.
  let result = localeValue
    .replace(
      new RegExp(
        `(${CJK_LATIN_SPACED_TERM_PATTERN})([\\u3040-\\u30ff\\u3400-\\u9fff\\uac00-\\ud7af])`,
        'g'
      ),
      '$1 $2'
    )
    .replace(
      new RegExp(
        `([\\u3040-\\u30ff\\u3400-\\u9fff\\uac00-\\ud7af])(${CJK_LATIN_SPACED_TERM_PATTERN})`,
        'g'
      ),
      '$1 $2'
    )
    .replace(
      new RegExp(`(${CJK_LATIN_SPACED_TERM_PATTERN})(${CJK_LATIN_SPACED_TERM_PATTERN})`, 'g'),
      '$1 $2'
    )
  if (locale === 'ko') {
    result = result.replace(
      new RegExp(
        `(${CJK_LATIN_SPACED_TERM_PATTERN}) (가|이|은|는|을|를|와|과|의|로|으로|에서|에게|도|만|부터|까지)`,
        'g'
      ),
      '$1$2'
    )
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
  const keyOverride = LOCALE_KEY_OVERRIDES[key]?.[locale]
  if (keyOverride) {
    // Why: exact key overrides can still carry stale MT output, so glossary repairs remain the final gate.
    let result = applyBrandMistranslationFixes(enValue, keyOverride, locale)
    result = applyPhraseFixes(enValue, result, locale)
    if (['zh', 'ja', 'ko'].includes(locale)) {
      result = applyCjkLatinTermSpacing(result, locale)
    }
    return result
  }

  if (shouldPreserveEnglishValue(enValue, key)) {
    return enValue
  }

  let result = LOCALE_VALUE_OVERRIDES[locale]?.[enValue] ?? localeValue

  if (key.includes('.search.')) {
    const searchOverride = SEARCH_KEYWORD_OVERRIDES[locale]?.[enValue]
    if (searchOverride) {
      result = searchOverride
    }
  }

  result = applyBrandMistranslationFixes(enValue, result, locale)
  result = applyPhraseFixes(enValue, result, locale)
  if (['zh', 'ja', 'ko'].includes(locale)) {
    result = applyCjkLatinTermSpacing(result, locale)
  }

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
