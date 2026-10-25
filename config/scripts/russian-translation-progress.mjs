import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { flattenCatalogEntries, resolveLocaleSourceKey } from './verify-localization-catalog.mjs'
import { shouldPreserveEnglishValue } from './locale-translation-policy.mjs'
import { collectCountLookupKeys } from './localization-count-lookups.mjs'
import reviewedInvariants from '../localization-russian-invariants.json' with { type: 'json' }

const LOCALES_DIR = path.join('src', 'renderer', 'src', 'i18n', 'locales')
const TRANSLATION_DOMAINS = [
  'daily-chat',
  'settings-onboarding-integrations',
  'automations-tasks-activity',
  'editor-browser-source-control',
  'navigation-workspace-runtime'
]
const NATIVE_LANGUAGE_LABELS = new Set(
  ['english', 'chinese', 'korean', 'japanese', 'spanish', 'french', 'portuguese', 'russian'].map(
    (language) => `settings.appearance.language.${language}`
  )
)

function unchangedIsInvariant(key, source) {
  return (
    NATIVE_LANGUAGE_LABELS.has(key) ||
    (reviewedInvariants[key]?.source === source && Boolean(reviewedInvariants[key]?.rationale)) ||
    shouldPreserveEnglishValue(source, key) ||
    !/\p{L}/u.test(source.replace(/\{\{[^}]+\}\}/g, ''))
  )
}

function translationDomain(key) {
  if (key.startsWith('components.native-chat.') || key.startsWith('auto.components.native.')) {
    return 'daily-chat'
  }
  if (
    /^(settings\.|onboarding\.|accounts\.|auto\.components\.(settings|onboarding|skills)\.)/.test(
      key
    )
  ) {
    return 'settings-onboarding-integrations'
  }
  if (
    /^(auto\.components\.(automations|activity|TaskPage|task|linear|GitHub|GitLab|Jira)|jira\.|project)/.test(
      key
    )
  ) {
    return 'automations-tasks-activity'
  }
  if (
    /^(auto\.components\.(editor|browser|right|source|diff|PullRequest)|browser\.|editor\.|sourceControl\.|file)/.test(
      key
    )
  ) {
    return 'editor-browser-source-control'
  }
  return 'navigation-workspace-runtime'
}

export function russianTranslationProgress(english, russian, countKeys = new Set()) {
  const enEntries = flattenCatalogEntries(english)
  const ruEntries = flattenCatalogEntries(russian)
  const missing = []
  const unchanged = []
  const unreviewedCopies = []
  const extra = []
  const domains = Object.fromEntries(TRANSLATION_DOMAINS.map((domain) => [domain, { ru: {} }]))
  let translated = 0
  for (const [key, source] of enEntries) {
    const target = ruEntries.get(key)
    if (typeof target === 'string' && target.trim().length > 0) {
      if (target === source) {
        unchanged.push(key)
        if (unchangedIsInvariant(key, source)) {
          continue
        }
        unreviewedCopies.push(key)
      } else {
        translated += 1
        continue
      }
    } else {
      missing.push(key)
    }
    const domain = translationDomain(key)
    domains[domain].ru[key] = {
      source,
      translation: '',
      ...(typeof target === 'string' ? { previousTranslation: target } : {})
    }
  }
  for (const [key, target] of ruEntries) {
    const sourceKey = resolveLocaleSourceKey(enEntries, 'ru', key)
    if (!sourceKey) {
      extra.push(key)
      continue
    }
    const source = enEntries.get(sourceKey)
    if (
      !enEntries.has(key) &&
      target === source &&
      !unchangedIsInvariant(key, source) &&
      !unchangedIsInvariant(sourceKey, source)
    ) {
      unreviewedCopies.push(key)
      domains[translationDomain(key)].ru[key] = {
        source,
        translation: '',
        previousTranslation: target
      }
    }
  }
  const missingPluralForms = []
  for (const base of [...countKeys].sort()) {
    const source = enEntries.get(`${base}_other`)
    if (!source) {
      continue
    }
    for (const category of new Intl.PluralRules('ru').resolvedOptions().pluralCategories) {
      const key = `${base}_${category}`
      const target = ruEntries.get(key)
      if (typeof target === 'string' && target.trim()) {
        continue
      }
      missingPluralForms.push(key)
      domains[translationDomain(key)].ru[key] = {
        source: enEntries.get(key) ?? source,
        translation: ''
      }
    }
  }
  return {
    missingPluralForms,
    sourceLeaves: enEntries.size,
    translated,
    unchanged,
    unreviewedCopies,
    missing,
    extra,
    pluralForms: [...ruEntries.keys()].filter(
      (key) => !enEntries.has(key) && resolveLocaleSourceKey(enEntries, 'ru', key)
    ).length,
    domains
  }
}

export async function main(root = process.cwd(), argv = process.argv.slice(2)) {
  const [english, russian] = await Promise.all(
    ['en', 'ru'].map(async (locale) =>
      JSON.parse(await fs.readFile(path.join(root, LOCALES_DIR, `${locale}.json`), 'utf8'))
    )
  )
  const progress = russianTranslationProgress(english, russian, await collectCountLookupKeys(root))
  const summary = {
    ...progress,
    domains: Object.fromEntries(
      Object.entries(progress.domains).map(([domain, delta]) => [
        domain,
        Object.keys(delta.ru).length
      ])
    )
  }
  const outputIndex = argv.indexOf('--write-missing')
  if (outputIndex !== -1) {
    const directory = argv[outputIndex + 1]
    if (!directory || directory.startsWith('--')) {
      throw new Error('--write-missing requires a directory')
    }
    await fs.mkdir(directory, { recursive: true })
    for (const [domain, delta] of Object.entries(progress.domains)) {
      await fs.writeFile(
        path.join(directory, `${domain}.json`),
        `${JSON.stringify(delta, null, 2)}\n`
      )
    }
    await fs.writeFile(
      path.join(directory, 'coverage.json'),
      `${JSON.stringify(summary, null, 2)}\n`
    )
  }
  if (argv.includes('--json')) {
    console.log(JSON.stringify(summary, null, 2))
  } else {
    console.log(
      `ru: ${progress.translated}/${progress.sourceLeaves} translated; ${progress.unchanged.length} equal to English (${progress.unreviewedCopies.length} unreviewed copies); ${progress.missing.length} missing; ${progress.pluralForms} additional plural forms; ${progress.extra.length} unknown IDs; ${progress.missingPluralForms.length} missing count forms.`
    )
    for (const [domain, count] of Object.entries(summary.domains)) {
      console.log(`${domain}: ${count} missing`)
    }
  }
  return progress.extra.length > 0 ||
    (argv.includes('--require-complete') &&
      (progress.missing.length > 0 ||
        progress.unreviewedCopies.length > 0 ||
        progress.missingPluralForms.length > 0))
    ? 1
    : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
