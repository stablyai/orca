import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import {
  collectStringLeaves,
  repairCatalog,
  repairTranslatedValue,
  setLeaf,
  shouldPreserveEnglishValue
} from './locale-translation-policy.mjs'

const PLACEHOLDER_RE = /\{\{[^}]+\}\}/g
const MOBILE_LOCALES_DIR = path.join('mobile', 'src', 'i18n', 'locales')
const DESKTOP_LOCALES_DIR = path.join('src', 'renderer', 'src', 'i18n', 'locales')

const LOCALE_CONFIG = {
  zh: { targetLanguage: 'zh-CN', displayName: 'Simplified Chinese' },
  ko: { targetLanguage: 'ko', displayName: 'Korean' },
  ja: { targetLanguage: 'ja', displayName: 'Japanese' },
  es: { targetLanguage: 'es', displayName: 'Spanish' }
}
const MOBILE_LOCALE_KEY_OVERRIDES = {
  'm.I-waJyg': { es: 'Conectando…', ja: '接続中…', ko: '연결 중…', zh: '正在连接…' },
  'm.zDZEMlw': { es: 'Conectando…', ja: '接続中…', ko: '연결 중…', zh: '正在连接…' },
  'm.T3HZLEU': { es: 'Conectando…', ja: '接続中…', ko: '연결 중…', zh: '正在连接…' },
  'm.X8_vuao': { es: 'Detener', ja: '停止', ko: '중지', zh: '停止' },
  'm.Scz67W0': { es: 'Continuar', ja: '続ける', ko: '계속', zh: '继续' },
  'm.qzEC9yM': { es: 'ascendente', ja: '昇順', ko: '오름차순', zh: '升序' },
  'm.2IFEfeA': { es: 'descendente', ja: '降順', ko: '내림차순', zh: '降序' },
  'm.EiCMRDA': {
    es: 'Sin preparar',
    ja: '未ステージ',
    ko: '스테이징되지 않음',
    zh: '未暂存'
  },
  'm.YcfLGog': { es: 'Preparado', ja: 'ステージ済み', ko: '스테이징됨', zh: '已暂存' },
  'm.FohFTKc': {
    es: 'Todos los repositorios',
    ja: 'すべてのリポジトリ',
    ko: '모든 리포지토리',
    zh: '所有仓库'
  },
  'm.dBmZ43Q': {
    es: 'Todos los repos',
    ja: 'すべてのリポジトリ',
    ko: '모든 저장소',
    zh: '所有代码库'
  },
  'm.zrhQGaA': {
    es: '{{value0}} repositorios',
    ja: '{{value0}} リポジトリ',
    ko: '저장소 {{value0}}개',
    zh: '{{value0}} 个代码库'
  },
  'm.px-yCeQ': {
    es: '{{value0}} comentario',
    ja: 'コメント {{value0}} 件',
    ko: '댓글 {{value0}}개',
    zh: '{{value0}} 条评论'
  },
  'm.Uv1hPbA': {
    es: '{{value0}} comentarios',
    ja: 'コメント {{value0}} 件',
    ko: '댓글 {{value0}}개',
    zh: '{{value0}} 条评论'
  },
  'm.ngn4NjA': {
    es: '{{value0}} commit por detrás (commit base:',
    ja: '{{value0}} コミット遅れ (ベースコミット:',
    ko: '{{value0}}개 커밋 뒤처짐 (기준 커밋:',
    zh: '落后 {{value0}} 个提交 (基础提交：'
  },
  'm.93sCYQo': {
    es: '{{value0}} commits por detrás (commit base:',
    ja: '{{value0}} コミット遅れ (ベースコミット:',
    ko: '{{value0}}개 커밋 뒤처짐 (기준 커밋:',
    zh: '落后 {{value0}} 个提交 (基础提交：'
  }
}

function protectPlaceholders(text) {
  const tokens = []
  const protectedText = text.replace(PLACEHOLDER_RE, (match) => {
    const token = `__PH${tokens.length}__`
    tokens.push(match)
    return token
  })
  return { protectedText, tokens }
}

function restorePlaceholders(text, tokens) {
  let result = text
  for (let index = 0; index < tokens.length; index += 1) {
    const patterns = [`__PH${index}__`, `__ PH ${index} __`, `__PH ${index}__`, `__ PH${index}__`]
    for (const pattern of patterns) {
      result = result.replaceAll(pattern, tokens[index])
    }
  }
  return result
}

const TRANSLATION_REQUEST_TIMEOUT_MS = 10_000

export function parseTranslationPayload(payload) {
  if (!Array.isArray(payload)) {
    throw new Error('Invalid translation response: expected a top-level array')
  }
  if (!Array.isArray(payload[0]) || payload[0].length === 0) {
    throw new Error(
      'Invalid translation response: expected a non-empty segment array at payload[0]'
    )
  }
  for (const [index, segment] of payload[0].entries()) {
    if (!Array.isArray(segment) || typeof segment[0] !== 'string') {
      throw new Error(
        `Invalid translation response: segment ${index} must have a string first item`
      )
    }
  }
  return payload[0].map((part) => part[0]).join('')
}

export async function translateText(text, targetLanguage) {
  const url = new URL('https://translate.googleapis.com/translate_a/single')
  url.searchParams.set('client', 'gtx')
  url.searchParams.set('sl', 'en')
  url.searchParams.set('tl', targetLanguage)
  url.searchParams.set('dt', 't')
  url.searchParams.set('q', text)

  let lastError
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TRANSLATION_REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) {
        throw new Error(`Translation request failed with status ${response.status}`)
      }
      const payload = await response.json()
      return parseTranslationPayload(payload)
    } catch (error) {
      lastError = error
    } finally {
      clearTimeout(timeout)
    }
    if (attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
    }
  }
  throw lastError
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = Array.from({ length: items.length })
  let nextIndex = 0

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await mapper(items[currentIndex], currentIndex)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
  return results
}

async function loadCache(cachePath) {
  try {
    const raw = JSON.parse(await fs.readFile(cachePath, 'utf8'))
    return new Map(Object.entries(raw))
  } catch {
    return new Map()
  }
}

async function saveCache(cachePath, cache) {
  await fs.writeFile(cachePath, `${JSON.stringify(Object.fromEntries(cache.entries()), null, 2)}\n`)
}

function mostFrequent(values) {
  const counts = new Map()
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0]
}

export function shouldReuseDesktopTranslation(english, translation) {
  return translation !== english || shouldPreserveEnglishValue(english)
}

export function repairMobileTranslatedValue(options) {
  return (
    MOBILE_LOCALE_KEY_OVERRIDES[options.key]?.[options.locale] ?? repairTranslatedValue(options)
  )
}

async function seedFromDesktopCatalog(root, locale, cache) {
  const enCatalog = JSON.parse(
    await fs.readFile(path.join(root, DESKTOP_LOCALES_DIR, 'en.json'), 'utf8')
  )
  const localeCatalog = JSON.parse(
    await fs.readFile(path.join(root, DESKTOP_LOCALES_DIR, `${locale}.json`), 'utf8')
  )
  const localeLeaves = new Map(
    collectStringLeaves(localeCatalog).map((leaf) => [leaf.key, leaf.value])
  )
  const translationsByEnglish = new Map()

  for (const leaf of collectStringLeaves(enCatalog)) {
    const translation = localeLeaves.get(leaf.key)
    if (!translation) {
      continue
    }
    const values = translationsByEnglish.get(leaf.value) ?? []
    values.push(translation)
    translationsByEnglish.set(leaf.value, values)
  }

  for (const [english, values] of translationsByEnglish) {
    const translation = mostFrequent(values)
    if (translation && shouldReuseDesktopTranslation(english, translation) && !cache.has(english)) {
      cache.set(english, translation)
    }
  }
}

function parseLocaleArg(argv) {
  const localeFlagIndex = argv.indexOf('--locale')
  if (localeFlagIndex !== -1 && argv[localeFlagIndex + 1]) {
    return argv[localeFlagIndex + 1]
  }
  return argv[2]
}

export async function main(root = process.cwd(), locale = parseLocaleArg(process.argv)) {
  const config = LOCALE_CONFIG[locale]
  if (!config) {
    console.error(
      `Unsupported locale "${locale}". Supported: ${Object.keys(LOCALE_CONFIG).join(', ')}`
    )
    return 1
  }

  const enPath = path.join(root, MOBILE_LOCALES_DIR, 'en.json')
  const localePath = path.join(root, MOBILE_LOCALES_DIR, `${locale}.json`)
  const cachePath = path.join(root, MOBILE_LOCALES_DIR, `.${locale}-catalog-cache.json`)
  const enCatalog = JSON.parse(await fs.readFile(enPath, 'utf8'))
  const localeCatalog = structuredClone(enCatalog)
  const leaves = collectStringLeaves(enCatalog)
  const uniqueValues = [...new Set(leaves.map((leaf) => leaf.value))]
  const cache = await loadCache(cachePath)
  await seedFromDesktopCatalog(root, locale, cache)

  const toTranslate = uniqueValues.filter(
    (value) => !shouldPreserveEnglishValue(value) && !cache.has(value)
  )
  console.log(
    `Translating ${toTranslate.length} mobile strings to ${config.displayName} (${cache.size} reused)...`
  )

  let completed = 0
  await mapWithConcurrency(toTranslate, 3, async (value) => {
    const { protectedText, tokens } = protectPlaceholders(value)
    const translated = await translateText(protectedText, config.targetLanguage)
    const restored = restorePlaceholders(translated, tokens)
    cache.set(
      value,
      repairTranslatedValue({ key: '', enValue: value, localeValue: restored, locale })
    )
    completed += 1
    if (completed % 25 === 0) {
      console.log(`  ${completed}/${toTranslate.length}`)
      await saveCache(cachePath, cache)
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  })

  for (const value of uniqueValues) {
    if (shouldPreserveEnglishValue(value) && !cache.has(value)) {
      cache.set(value, value)
    }
  }
  await saveCache(cachePath, cache)

  for (const leaf of leaves) {
    setLeaf(
      localeCatalog,
      leaf.key,
      repairMobileTranslatedValue({
        key: leaf.key,
        enValue: leaf.value,
        localeValue: cache.get(leaf.value) ?? leaf.value,
        locale
      })
    )
  }
  repairCatalog(enCatalog, localeCatalog, locale)

  await fs.writeFile(localePath, `${JSON.stringify(localeCatalog, null, 2)}\n`)
  console.log(`Wrote ${localePath}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
