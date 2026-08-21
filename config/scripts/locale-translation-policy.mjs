import { CJK_LATIN_SPACED_TERMS } from './locale-cjk-latin-spaced-terms.mjs'
import {
  isCanonicalGenericRendering,
  overlapsCanonicalRendering
} from './locale-generic-ui-terms.mjs'
import { isScreenCursorContext } from './locale-screen-cursor-exemptions.mjs'
import { BRAND_MISTRANSLATIONS } from './locale-brand-mistranslations.mjs'
import { isStyleValue } from './locale-style-values.mjs'
import { LOCALE_KEY_OVERRIDES } from './locale-key-overrides.mjs'
import { LOCALE_PHRASE_FIXES } from './locale-phrase-fixes.mjs'
import { SEARCH_KEYWORD_OVERRIDES } from './locale-search-keyword-overrides.mjs'
import { LOCALE_VALUE_OVERRIDES } from './locale-value-overrides.mjs'

export { BRAND_MISTRANSLATIONS } from './locale-brand-mistranslations.mjs'
export { LOCALE_KEY_OVERRIDES } from './locale-key-overrides.mjs'
export { LOCALE_PHRASE_FIXES } from './locale-phrase-fixes.mjs'
export { SEARCH_KEYWORD_OVERRIDES } from './locale-search-keyword-overrides.mjs'
export { LOCALE_VALUE_OVERRIDES } from './locale-value-overrides.mjs'

const AGENT_CATALOG_PREFIX = 'auto.lib.agent.catalog.'
const OPEN_IN_APP_CATALOG_PREFIX = 'auto.lib.open.in.app.catalog.'

// Why: product names and agent labels stay Latin — MT reads them as common words (Codex→copy, Gemini→zodiac).
export const ENGLISH_ONLY_KEY_PREFIXES = [AGENT_CATALOG_PREFIX, OPEN_IN_APP_CATALOG_PREFIX]

// Only genuine brand, product, and code tokens belong here. Ordinary UI words that happen to
// name a product (agent, terminal, commit, repo, Continue) live in locale-generic-ui-terms.mjs
// and are translated; their product sense is pinned by ENGLISH_ONLY_KEY_PREFIXES instead.
export const NEVER_TRANSLATE_VALUES = new Set([
  'Aider',
  'Amp',
  'Android',
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
  'Cursor',
  'Droid',
  'Devin',
  'Gemini',
  'Git',
  'Git Bash',
  'GitHub Copilot',
  'GitLab',
  'Goose',
  'Grok',
  'Hermes',
  'Jira',
  'Kilocode',
  'Kimi',
  'Kiro',
  'Linear',
  'Mistral Vibe',
  'OMP',
  'OpenClaude',
  'OpenClaw',
  'OpenCode',
  'OpenCode Go',
  'Orca',
  'Pi',
  'PostHog',
  'Qwen Code',
  'Rovo Dev',
  'Markdown',
  'VS Code',
  'Warp',
  'Zed',
  'android',
  'codex',
  'gemini',
  'claude',
  'markdown',
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
  'Beta',
  // Round 6: product/tool names, language names, and code tokens that machine
  // translation wrongly localized (e.g. tailscale→尾鱗, Swift→迅速, yarn→糸).
  'Tailscale',
  'tailscale',
  'Ghostty',
  'ghostty',
  'pwsh',
  'yarn',
  'Kagi',
  'kagi',
  'kimi',
  'Bitbucket',
  'bitbucket',
  'GNOME',
  'gnome',
  'iCloud',
  'icloud',
  'ripgrep',
  'PowerShell',
  'powershell',
  'TypeScript',
  'typescript',
  'Mermaid',
  'mermaid',
  'Swift',
  'swift',
  'Rust',
  'rust',
  'Java',
  'java',
  'Go',
  'Python',
  'python',
  'Kotlin',
  'kotlin',
  'Ruby',
  'ruby',
  'Bash',
  'bash',
  'GraphQL',
  'graphql',
  'iOS',
  'iPhone',
  'iPad',
  'ide',
  'IDE',
  'ui',
  'UI',
  'calt',
  'ai',
  'AI',
  'ci',
  'CI',
  'REST',
  'rest',
  'YAML',
  'yaml',
  'yml',
  'XML',
  'SQL',
  'CSS',
  'Token',
  'token',
  'HTTP/1.1',
  'HTTP/2',
  'true',
  'false',
  '/home/user',
  '/home/user/project',
  '/path/to/destination',
  '.orca/issue-command',
  'PLAN.md',
  'feat/mobile-page',
  'sk-...',
  'main',
  'master',
  'HEAD',
  'lint',
  'MD',
  '/home/user/projects',
  'Claude Code',
  // Commands, refs, class strings and code samples: a translated one no longer runs or matches.
  'pnpm install',
  'glab auth login',
  "gh pr list --json number -q '.[0].number'",
  '--model sonnet',
  'localhost, 127.0.0.1, *.internal',
  'packages/web shared/ui',
  'stale-agent-row-{{value0}}',
  'text-foreground',
  'source-control',
  'combined-branch',
  'pr-view',
  'fix-login-flow',
  'my-project',
  'serve-sim',
  'pnpm playwright test',
  'gh auth login',
  'size-4 text-muted-foreground',
  'text-amber-700 dark:text-amber-300',
  'text-emerald-700 dark:text-emerald-300',
  'src/renderer packages/ui',
  'upstream/main',
  'origin/main',
  'example.com',
  'bastion.example.com',
  'dashboard.spec.ts',
  'checkout.spec.ts',
  'login.spec.ts',
  'untitled.md',
  'review src/auth',
  'throw src/auth',
  // Rendered inside <code> or a font-mono element, so they are code the user copies or types.
  '{prompt}',
  '{basePrompt}',
  '{firstPrompt}',
  '{assistantMessage}',
  '/goal',
  '/pricing',
  '/signup',
  'npm run dev',
  'nbformat',
  'orca.yaml',
  'upstream',
  'LIN-329',
  'GH #1799',
  'orca · zsh'
])

export const NATIVE_PICKER_LABELS = {
  zh: { chinese: '中文（简体）', korean: '한국어', japanese: '日本語', spanish: 'Español' },
  ko: { chinese: '中文（简体）', korean: '한국어', japanese: '日本語', spanish: 'Español' },
  ja: { chinese: '中文（简体）', korean: '한국어', japanese: '日本語', spanish: 'Español' },
  es: { chinese: '中文（简体）', korean: '한국어', japanese: '日本語', spanish: 'Español' }
}

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
  if (isStyleValue(enValue)) {
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

function replaceMistranslatedForm(value, wrong, brand, locale) {
  let result = ''
  let cursor = 0
  for (let at = value.indexOf(wrong); at !== -1; at = value.indexOf(wrong, cursor)) {
    const end = at + wrong.length
    result += value.slice(cursor, at)
    result += overlapsCanonicalRendering(brand, locale, value, at, end) ? wrong : brand
    cursor = end
  }
  return result + value.slice(cursor)
}

function applyBrandMistranslationFixes(enValue, localeValue, locale, key = '') {
  let result = localeValue
  const mistranslations = BRAND_MISTRANSLATIONS[locale] ?? {}

  for (const [brand, wrongForms] of Object.entries(mistranslations).sort(
    ([left], [right]) => right.length - left.length
  )) {
    if (!includesPreservedLatinTerm(enValue, brand)) {
      continue
    }
    // Why: terminal/theme "Cursor" labels name the on-screen カーソル, not the Cursor product —
    // skip the revert so カーソル survives for these settings.
    if (isScreenCursorContext(brand, enValue, key)) {
      continue
    }
    if (includesPreservedLatinTerm(result, brand)) {
      continue
    }
    for (const wrong of wrongForms) {
      if (!result.includes(wrong)) {
        continue
      }
      // Why: #12113 — a generic term's correct translation is not a mistranslation; reverting it
      // rewrote ~2000 translated values back to English on every repair run.
      if (isCanonicalGenericRendering(brand, locale, wrong)) {
        continue
      }
      // Why: "Copy identifier" legitimately uses 사본/复制 — only swap when English names the brand.
      if (brand === 'Codex' && /\bCopy\b/i.test(enValue)) {
        continue
      }
      result = replaceMistranslatedForm(result, wrong, brand, locale)
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
    // Korean particles attach to the noun (no space) only when the particle is a complete token at a
    // boundary — re-glue "Orca 에"/"PR 을"/"에서는" but keep "Jira 이슈"/"Orca 로고"/"agent 에뮬레이터".
    result = result.replace(
      new RegExp(
        `(${CJK_LATIN_SPACED_TERM_PATTERN}) ((?:에서|에게|에는|에선|으로|로서|로써|부터|까지|보다|처럼|은|는|이|가|을|를|와|과|의|에|로|도|만)+)(?=$|[\\s.,!?…·:;)\\]}"'」』])`,
        'g'
      ),
      '$1$2'
    )
  }
  return result
}

function phraseFixMatchesEnglish(enValue, fix) {
  // Why: `whenEnMatches` (a RegExp) lets a rule guard on a real token (e.g. /\bPRs?\b/)
  // instead of the looser case-insensitive `whenEnIncludes` substring, so a phrase fix can
  // avoid firing on unrelated English that merely contains the substring (approve, preview).
  if (fix.whenEnMatches) {
    return fix.whenEnMatches.test(enValue)
  }
  return enValue.toLowerCase().includes(fix.whenEnIncludes.toLowerCase())
}

function applyPhraseFixes(enValue, localeValue, locale) {
  let result = localeValue
  for (const fix of LOCALE_PHRASE_FIXES[locale] ?? []) {
    if (!phraseFixMatchesEnglish(enValue, fix)) {
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
    let result = applyBrandMistranslationFixes(enValue, keyOverride, locale, key)
    result = applyPhraseFixes(enValue, result, locale)
    if (['zh', 'ja', 'ko'].includes(locale)) {
      result = applyCjkLatinTermSpacing(result, locale)
    }
    return result
  }

  const valueOverride = LOCALE_VALUE_OVERRIDES[locale]?.[enValue]
  if (valueOverride) {
    let result = applyBrandMistranslationFixes(enValue, valueOverride, locale, key)
    result = applyPhraseFixes(enValue, result, locale)
    if (['zh', 'ja', 'ko'].includes(locale)) {
      result = applyCjkLatinTermSpacing(result, locale)
    }
    return result
  }

  if (shouldPreserveEnglishValue(enValue, key)) {
    return enValue
  }

  let result = localeValue

  if (key.includes('.search.')) {
    const searchOverride = SEARCH_KEYWORD_OVERRIDES[locale]?.[enValue]
    if (searchOverride) {
      result = searchOverride
    }
  }

  result = applyBrandMistranslationFixes(enValue, result, locale, key)
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
    // Why: en.json carries keys the locale catalog has not been bootstrapped with yet; repair only
    // rewrites values that already exist, so skip instead of crashing on undefined.
    if (typeof current !== 'string') {
      continue
    }
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
