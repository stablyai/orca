import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// TypeScript 7 is a native CLI; AST consumers still need the legacy JavaScript API.
import ts from 'typescript-api'

import { main as verifyRuntimeCatalog } from './generate-runtime-required-english-catalog.mjs'
import { LOCALIZATION_SURFACES } from './localization-surfaces.mjs'
import {
  collectLocalizationReferences,
  collectSourceFiles,
  main as verifyCatalog
} from './verify-localization-catalog.mjs'
import {
  collectKeyLiterals,
  compareExtraction,
  findUnreferencedKeys
} from './verify-localization-extraction.mjs'

const SURFACE = LOCALIZATION_SURFACES.mobile
const APP_CONFIG_PATH = path.join('mobile', 'app.json')
const ANDROID_LOCALE_PLUGIN = './plugins/android-locale-config.js'
const PLURAL_POLYFILL_PATH = path.join('mobile', 'src', 'i18n', 'plural-rules-polyfill.ts')
// The runtime owns the subscription that every other caller must go through.
const I18N_RUNTIME_DIR = 'mobile/src/i18n/'
const UI_LOCALE_SOURCE_PATH = path.join('src', 'shared', 'ui-locale.ts')
// Apple lproj and Android locale_config name these by script/region; the rest match the UI locale id.
const NATIVE_LOCALE_TAGS = { zh: 'zh-Hans', pt: 'pt-BR' }
const PLURAL_SUFFIX_RE = /^(.*)_(zero|one|two|few|many|other)$/
const FUNCTION_LIKE_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor
])

function normalizePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/')
}

function flattenCatalog(value, prefix = '', entries = new Map()) {
  if (typeof value === 'string') {
    entries.set(prefix, value)
    return entries
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return entries
  }
  for (const [key, child] of Object.entries(value)) {
    flattenCatalog(child, prefix ? `${prefix}.${key}` : key, entries)
  }
  return entries
}

function nestCatalog(entries) {
  const catalog = {}
  for (const [key, value] of entries) {
    const parts = key.split('.')
    let cursor = catalog
    for (const part of parts.slice(0, -1)) {
      cursor[part] ??= {}
      cursor = cursor[part]
    }
    cursor[parts.at(-1)] = value
  }
  return catalog
}

async function readJson(root, relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'))
}

async function readSupportedUiLocales(root) {
  const source = await fs.readFile(path.join(root, UI_LOCALE_SOURCE_PATH), 'utf8')
  const list = /SUPPORTED_UI_LOCALES = \[([^\]]*)\]/.exec(source)?.[1] ?? ''
  return [...list.matchAll(/'([^']+)'/g)].map((match) => match[1])
}

function report(problems, heading, lines) {
  if (lines.length === 0) {
    return
  }
  problems.push(`${heading}\n${lines.map((line) => `  ${line}`).join('\n')}`)
}

// Extraction here is the call-site scan itself: every literal `t`/`translate` key and fallback.
export function collectExtractionProblems(references, englishCatalog, keyEvidence) {
  const extracted = new Map()
  for (const reference of references) {
    // A dynamic fallback elsewhere must not hide a literal one that drifted from en.json.
    if (typeof reference.fallback === 'string') {
      extracted.set(reference.key, reference.fallback)
    } else if (!extracted.has(reference.key)) {
      extracted.set(reference.key, '')
    }
  }
  const result = compareExtraction(nestCatalog(extracted), englishCatalog)
  // A family is live when any form is named: a counted `items_one` call still resolves `items_other`.
  const familyOf = (key) => PLURAL_SUFFIX_RE.exec(key)?.[1]
  const liveFamilies = new Set(
    [...result.extracted.keys(), ...keyEvidence.literals].map(familyOf).filter(Boolean)
  )
  const unreferenced = findUnreferencedKeys(result.orphans, result.extracted, keyEvidence).filter(
    (key) => !liveFamilies.has(familyOf(key))
  )
  return {
    fallbackDrift: result.fallbackDrift.map(
      (key) =>
        `${key}\n    en.json: ${JSON.stringify(result.english.get(key))}\n    source:  ${JSON.stringify(result.extracted.get(key))}`
    ),
    unreferenced
  }
}

// A locale that translates a plural family must supply each of its CLDR categories, or counts fall back to English.
export function collectIncompletePluralFamilies(englishEntries, localeEntries, locale) {
  const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories
  const families = new Set()
  for (const key of englishEntries.keys()) {
    const plural = PLURAL_SUFFIX_RE.exec(key)
    if (plural) {
      families.add(plural[1])
    }
  }
  const incomplete = []
  for (const family of families) {
    const supplied = [...localeEntries.keys()].some(
      (key) => PLURAL_SUFFIX_RE.exec(key)?.[1] === family
    )
    const translated = categories.filter((category) => localeEntries.has(`${family}_${category}`))
    if (supplied && translated.length < categories.length) {
      const missing = categories.filter((category) => !localeEntries.has(`${family}_${category}`))
      incomplete.push(`${family}: missing ${missing.map((category) => `_${category}`).join(', ')}`)
    }
  }
  return incomplete
}

function functionName(node) {
  if (node.name && ts.isIdentifier(node.name)) {
    return node.name.text
  }
  const isDefaultExport =
    ts.isExportAssignment(node.parent) ||
    (node.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
  if (isDefaultExport) {
    // `export default function () {}` in a .tsx file is a screen component.
    return 'DefaultExport'
  }
  let current = node.parent
  // Unwrap memo(...)/forwardRef(...) so `const Row = memo(() => ...)` is still the component Row.
  while (current && ts.isCallExpression(current)) {
    current = current.parent
  }
  if (current && ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
    return current.name.text
  }
  return undefined
}

function isComponentOrHook(name, isTsx) {
  return name !== undefined && (/^use[A-Z0-9]/.test(name) || (isTsx && /^[A-Z]/.test(name)))
}

const DEFERRED_CALLEES = new Set([
  'useCallback',
  'useEffect',
  'useLayoutEffect',
  'useInsertionEffect',
  'setTimeout',
  'requestAnimationFrame',
  'queueMicrotask',
  'then',
  'catch',
  'finally'
])

// Handlers, effects and async continuations run after render, reading the language current then.
function runsAfterRender(fn) {
  if (fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
    return true
  }
  const parent = fn.parent
  if (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)) {
    return /^on[A-Z]/.test(parent.parent.name.getText())
  }
  // Named local functions are callbacks unless they are render helpers (`renderRow`).
  const name = ts.isFunctionDeclaration(fn)
    ? fn.name?.text
    : (ts.isPropertyAssignment(parent) || ts.isVariableDeclaration(parent)) &&
        ts.isIdentifier(parent.name)
      ? parent.name.text
      : undefined
  if (name !== undefined) {
    return !/^render/i.test(name)
  }
  if (ts.isCallExpression(parent) && parent.arguments.includes(fn)) {
    const callee = ts.isPropertyAccessExpression(parent.expression)
      ? parent.expression.name.text
      : ts.isIdentifier(parent.expression)
        ? parent.expression.text
        : ''
    return DEFERRED_CALLEES.has(callee)
  }
  return false
}

// Render-time code inside a component or hook: walk out through nested callbacks (map, memo) until
// a handler/effect boundary or the component itself.
function rendersInComponentOrHook(functions, isTsx) {
  for (const fn of functions) {
    if (isComponentOrHook(functionName(fn), isTsx)) {
      return true
    }
    if (runsAfterRender(fn)) {
      return false
    }
  }
  return false
}

// Live switching needs subscribed renders: render bodies and memos of components and hooks take `t`
// from useMobileTranslation() (handlers and effects may call translate() when they run),
// and nothing translates at import time, before the saved language is active.
export function collectLiveSwitchViolations(filePath, sourceText) {
  const isTsx = filePath.endsWith('.tsx')
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const violations = []

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text
      if (callee === 'translate' || callee === 't') {
        const functions = []
        for (let current = node.parent; current; current = current.parent) {
          if (FUNCTION_LIKE_KINDS.has(current.kind)) {
            functions.push(current)
          }
        }
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        const location = `${filePath}:${line + 1}`
        if (functions.length === 0) {
          violations.push(
            `${location} translates at module scope; translate when rendering instead`
          )
        } else if (
          callee === 'translate' &&
          !filePath.startsWith(I18N_RUNTIME_DIR) &&
          rendersInComponentOrHook(functions, isTsx)
        ) {
          violations.push(
            `${location} calls translate() in a component or hook; use \`const t = useMobileTranslation()\``
          )
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}

async function collectNativeLocaleProblems(root, supportedLocales) {
  const problems = []
  const expo = (await readJson(root, APP_CONFIG_PATH)).expo
  const expected = supportedLocales.map((locale) => NATIVE_LOCALE_TAGS[locale] ?? locale).sort()
  const pluginLocales = (name) =>
    expo.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === name)?.[1]
  const declared = {
    'expo.locales': Object.keys(expo.locales ?? {}),
    'expo-localization supportedLocales.ios':
      pluginLocales('expo-localization')?.supportedLocales?.ios ?? [],
    [ANDROID_LOCALE_PLUGIN]: pluginLocales(ANDROID_LOCALE_PLUGIN)?.locales ?? []
  }
  for (const [where, tags] of Object.entries(declared)) {
    if ([...tags].sort().join() !== expected.join()) {
      problems.push(`${where} lists ${tags.join(', ')}; expected ${expected.join(', ')}`)
    }
  }

  const english = await readJson(root, path.join('mobile', expo.locales.en))
  const englishKeys = Object.keys(english.ios ?? {}).sort()
  for (const [tag, file] of Object.entries(expo.locales ?? {})) {
    const strings = (await readJson(root, path.join('mobile', file))).ios ?? {}
    if (Object.keys(strings).sort().join() !== englishKeys.join()) {
      problems.push(`${file} must define exactly ${englishKeys.join(', ')}`)
    }
    for (const [key, value] of Object.entries(strings)) {
      // Expo writes InfoPlist.strings without escaping.
      if (typeof value !== 'string' || !value.trim() || /["\\\n]/.test(value)) {
        problems.push(`${file} ${key} must be one line of text without " or \\ (${tag})`)
      }
    }
  }
  return problems
}

async function collectPolyfillProblems(root, supportedLocales) {
  const source = await fs.readFile(path.join(root, PLURAL_POLYFILL_PATH), 'utf8')
  const languages = new Set(supportedLocales.map((locale) => locale.split('-')[0]))
  return [...languages]
    .filter((language) => !source.includes(`locale-data/${language}.js'`))
    .map((language) => `${PLURAL_POLYFILL_PATH} does not load plural rules for ${language}`)
}

// --fix drops keys no code names any more from every catalog, plural siblings included.
async function pruneCatalogKeys(root, keys) {
  // Locale-only plural forms (few, many) go only when no English form of the family is still used.
  const english = flattenCatalog(
    JSON.parse(await fs.readFile(path.join(root, SURFACE.localesDir, 'en.json'), 'utf8'))
  )
  const familyOf = (key) => PLURAL_SUFFIX_RE.exec(key)?.[1]
  const families = new Set(
    keys
      .map(familyOf)
      .filter(
        (family) =>
          family &&
          [...english.keys()].every((key) => familyOf(key) !== family || keys.includes(key))
      )
  )
  const doomed = (key) =>
    keys.includes(key) || families.has(PLURAL_SUFFIX_RE.exec(key)?.[1] ?? '\0')
  const dir = path.join(root, SURFACE.localesDir)
  for (const name of (await fs.readdir(dir)).filter((file) => file.endsWith('.json'))) {
    const entries = flattenCatalog(JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')))
    const kept = new Map([...entries].filter(([key]) => !doomed(key)))
    if (kept.size !== entries.size) {
      await fs.writeFile(path.join(dir, name), `${JSON.stringify(nestCatalog(kept), null, 2)}\n`)
    }
  }
  console.log(`Removed ${keys.length} unreferenced key(s) from the mobile catalogs.`)
}

async function scanSources(root) {
  const files = []
  for (const sourceRoot of SURFACE.sourceRoots) {
    files.push(...(await collectSourceFiles(root, path.join(root, sourceRoot))))
  }
  const keyEvidence = { literals: new Set(), dynamicPrefixes: new Set() }
  const liveSwitchViolations = []
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8')
    collectKeyLiterals(text, keyEvidence)
    liveSwitchViolations.push(...collectLiveSwitchViolations(normalizePath(root, file), text))
  }
  return { keyEvidence, liveSwitchViolations }
}

export async function main(root = process.cwd(), argv = process.argv.slice(2)) {
  const fix = argv.includes('--fix')
  const references = await collectLocalizationReferences(root, SURFACE.sourceRoots)
  const { keyEvidence, liveSwitchViolations } = await scanSources(root)
  if (fix) {
    const stale = collectExtractionProblems(
      references,
      await readJson(root, path.join(SURFACE.localesDir, 'en.json')),
      keyEvidence
    ).unreferenced
    if (stale.length > 0) {
      await pruneCatalogKeys(root, stale)
    }
  }
  // Shared catalog rules first; --fix adds new English declarations before the checks below read en.json.
  const catalogExit = await verifyCatalog(
    root,
    { fix, pluginCatalogs: [], surface: SURFACE },
    references
  )
  const runtimeExit = await verifyRuntimeCatalog(
    root,
    ['--surface', 'mobile', ...(fix ? ['--fix'] : [])],
    references
  )

  const problems = []
  const supportedLocales = await readSupportedUiLocales(root)
  const englishCatalog = await readJson(root, path.join(SURFACE.localesDir, 'en.json'))
  const englishEntries = flattenCatalog(englishCatalog)

  const { fallbackDrift, unreferenced } = collectExtractionProblems(
    references,
    englishCatalog,
    keyEvidence
  )
  report(
    problems,
    'Inline fallbacks differ from mobile en.json. The catalog value is what renders: update en.json and every locale, or use a new key.',
    fallbackDrift
  )
  report(
    problems,
    'Mobile catalog keys no source references. Run `pnpm sync:mobile-localization` to delete them from every catalog.',
    unreferenced
  )
  report(problems, 'Translations that cannot follow a language switch:', liveSwitchViolations)

  const catalogFiles = (await fs.readdir(path.join(root, SURFACE.localesDir)))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''))
  report(problems, `${SURFACE.localesDir} must hold exactly one catalog per supported UI locale:`, [
    ...supportedLocales
      .filter((locale) => !catalogFiles.includes(locale))
      .map((l) => `missing ${l}`),
    ...catalogFiles.filter((locale) => !supportedLocales.includes(locale)).map((l) => `extra ${l}`)
  ])
  for (const locale of supportedLocales.filter((name) => name !== 'en')) {
    const localeEntries = flattenCatalog(
      await readJson(root, path.join(SURFACE.localesDir, `${locale}.json`))
    )
    report(
      problems,
      `${locale}.json plural families without every ${locale} CLDR category:`,
      collectIncompletePluralFamilies(englishEntries, localeEntries, locale)
    )
    report(
      problems,
      `${locale}.json has empty translations; omit the key to fall back to English:`,
      [...localeEntries].filter(([, value]) => !value.trim()).map(([key]) => key)
    )
  }
  report(
    problems,
    'Native locale configuration:',
    await collectNativeLocaleProblems(root, supportedLocales)
  )
  report(problems, 'Plural rules polyfill:', await collectPolyfillProblems(root, supportedLocales))

  for (const problem of problems) {
    console.error(`${problem}\n`)
  }
  if (problems.length === 0 && catalogExit === 0 && runtimeExit === 0) {
    console.log(
      `Mobile localization verified: ${references.length} call sites, ${englishEntries.size} English entries.`
    )
    return 0
  }
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
