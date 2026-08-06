import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

// TypeScript 7 is a native CLI; AST consumers still need the legacy JavaScript API.
import ts from 'typescript-api'

import {
  collectMobileTranslationBindings,
  isMobileTranslationCall,
  mobileTranslationCallPrefix
} from './mobile-localization-translation-bindings.mjs'
import {
  EXACT_LANGUAGE_NEUTRAL_KEYS,
  PRODUCT_GLOSSARY,
  REVIEWED_KEY_TRANSLATIONS,
  REQUIRED_TARGET_TRANSLATIONS
} from './mobile-localization-product-glossary.mjs'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'])
const SOURCE_RELATIVE_ROOTS = [path.join('mobile', 'app'), path.join('mobile', 'src')]
const LOCALES_RELATIVE_DIR = path.join('mobile', 'src', 'i18n', 'locales')
const MOBILE_LOCALES = ['en', 'es', 'ja', 'ko', 'zh']
const NATIVE_LOCALES = ['en', 'es', 'ja', 'ko', 'zh-Hans']
const NATIVE_LOCALES_RELATIVE_DIR = path.join('mobile', 'locales')
const NATIVE_REQUIRED_KEYS = [
  'ios.CFBundleDisplayName',
  'ios.NSCameraUsageDescription',
  'ios.NSLocalNetworkUsageDescription',
  'ios.NSMicrophoneUsageDescription',
  'ios.NSPhotoLibraryUsageDescription',
  'android.app_name'
]
const NATIVE_LOCALE_PATHS = new Map(
  NATIVE_LOCALES.map((locale) => [locale, `./locales/${locale}.json`])
)
const RUNTIME_TO_NATIVE_LOCALE = new Map([
  ['en', 'en'],
  ['es', 'es'],
  ['ja', 'ja'],
  ['ko', 'ko'],
  ['zh', 'zh-Hans']
])
const PROTECTED_LITERALS = [
  'sudo ufw allow 6768',
  'npm run dev',
  'pnpm build',
  'stablyai/orca',
  'onOrca.dev',
  'orca.yaml',
  'Tailscale',
  'GitHub',
  'GitLab',
  'Codex',
  'Claude',
  'Orca',
  'WSL',
  'SSH',
  'HEAD',
  'MR !',
  'HOOKS'
]
const PLACEHOLDER_RE = /\{\{\s*([^,}\s]+)(?:,[^}]*)?\}\}/g
const ENCODED_HTML_ENTITY_RE = /&(?:amp|apos|gt|lt|quot);/i
const INTENT_MESSAGE_ID_RE = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/
const POSITIONAL_PLACEHOLDER_RE = /^value\d+$/
const LANGUAGE_NEUTRAL_VALUES = new Set([
  '@orca_build',
  '[x]',
  'Aider',
  'Amp',
  'Ante',
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
  'Devin',
  'Droid',
  'Gemini',
  'GitHub',
  'GitHub Copilot',
  'GitHub Releases',
  'GitLab',
  'Goose',
  'Grok',
  'HEAD',
  'Hermes',
  'Kilocode',
  'Kimi',
  'Kiro',
  'Linear',
  'Markdown',
  'MiMo Code',
  'Mistral Vibe',
  'MR',
  'MR !',
  'OMP',
  'onOrca.dev',
  'OpenAI API',
  'OpenClaude',
  'OpenClaw',
  'OpenCode',
  'Orca',
  'Orca Relay',
  'orca.yaml',
  'ORCA.YAML',
  'Pi',
  'PR',
  'Qwen Code',
  'Rovo Dev',
  'stablyai/orca',
  'Trae',
  'YYYY-MM-DD'
])
const EXACT_LANGUAGE_NEUTRAL_VALUES = new Set(['[x]', 'OpenAI API'])

function normalizePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/')
}

function isSourceFile(filePath) {
  const fileName = path.basename(filePath)
  return (
    SOURCE_EXTENSIONS.has(path.extname(fileName)) &&
    !fileName.includes('.test.') &&
    !fileName.includes('.spec.')
  )
}

async function collectSourceFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const filePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(filePath)))
    } else if (entry.isFile() && isSourceFile(filePath)) {
      files.push(filePath)
    }
  }

  return files
}

function flattenCatalog(value, catalogName, prefix = '', entries = new Map(), issues = []) {
  if (typeof value === 'string') {
    entries.set(prefix, value)
    if (value.trim().length === 0) {
      issues.push(`${catalogName}: ${prefix} must not be empty`)
    }
    if (ENCODED_HTML_ENTITY_RE.test(value)) {
      issues.push(`${catalogName}: ${prefix} contains an encoded HTML entity`)
    }
    return { entries, issues }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push(`${catalogName}: ${prefix || '<root>'} must be a string or object`)
    return { entries, issues }
  }
  for (const [key, child] of Object.entries(value)) {
    flattenCatalog(child, catalogName, prefix ? `${prefix}.${key}` : key, entries, issues)
  }
  return { entries, issues }
}

function locationFor(root, filePath, sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return `${normalizePath(root, filePath)}:${position.line + 1}:${position.character + 1}`
}

function unwrapExpression(node) {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return unwrapExpression(node.expression)
  }
  return node
}

function collectKeyBranches(node) {
  const expression = unwrapExpression(node)
  if (ts.isStringLiteralLike(expression)) {
    return { keys: [expression.text], inspected: true }
  }
  if (ts.isConditionalExpression(expression)) {
    const whenTrue = collectKeyBranches(expression.whenTrue)
    const whenFalse = collectKeyBranches(expression.whenFalse)
    return {
      keys: [...whenTrue.keys, ...whenFalse.keys],
      inspected: whenTrue.inspected && whenFalse.inspected
    }
  }
  return { keys: [], inspected: false }
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  return undefined
}

function collectOptionNames(node) {
  if (!node) {
    return { inspected: true, names: [] }
  }
  const expression = unwrapExpression(node)
  if (!ts.isObjectLiteralExpression(expression)) {
    return { inspected: false, names: [] }
  }

  const names = []
  for (const property of expression.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      names.push(property.name.text)
      continue
    }
    if (ts.isPropertyAssignment(property)) {
      const name = propertyNameText(property.name)
      if (name !== undefined) {
        names.push(name)
        continue
      }
    }
    return { inspected: false, names: [] }
  }
  return { inspected: true, names: [...new Set(names)].sort() }
}

function collectPlaceholderNames(value) {
  const names = []
  for (const match of value.matchAll(PLACEHOLDER_RE)) {
    names.push(match[1])
  }
  return [...new Set(names)].sort()
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function occurrenceCount(value, literal) {
  return value.split(literal).length - 1
}

function verifyProtectedLiterals(englishValue, localeValue, catalogName, key) {
  const issues = []
  for (const literal of PROTECTED_LITERALS) {
    if (occurrenceCount(localeValue, literal) < occurrenceCount(englishValue, literal)) {
      issues.push(`${catalogName} protected literal mismatch: ${key} must preserve ${literal}`)
    }
  }
  return issues
}

function isLanguageNeutralValue(value, locale) {
  const withoutPlaceholders = value.replace(PLACEHOLDER_RE, '').trim()
  return (
    LANGUAGE_NEUTRAL_VALUES.has(value) ||
    /^(?:Alt|Ctrl|Shift)(?:\+(?:[A-Z]|Tab))?$/.test(value) ||
    /^(?:Del|Enter|Esc|Ins|PgDn|PgUp|Tab)$/.test(value) ||
    /^(?:F|H)\d{1,2}$/.test(value) ||
    /^(?:https?:\/\/|orca:\/\/|lin_api_)\S+$/.test(value) ||
    /^(?:npm run dev|Linux: sudo ufw allow 6768|src\/renderer packages\/ui)$/.test(value) ||
    (locale === 'es' && /^(?:commit|commits)$/.test(withoutPlaceholders)) ||
    withoutPlaceholders === '' ||
    withoutPlaceholders === '..HEAD' ||
    withoutPlaceholders === '×'
  )
}

function verifyTerminology(englishValue, localeValue, locale, catalogName, key) {
  const issues = []
  if (
    locale === 'es' &&
    /\bbranch(?:es)?\b/i.test(englishValue) &&
    /\bsucursal(?:es)?\b/i.test(localeValue)
  ) {
    issues.push(`${catalogName} Git terminology mismatch: ${key} translates branch as sucursal`)
  }
  if (locale === 'zh' && /\bhost\b/i.test(englishValue) && localeValue.includes('主人')) {
    issues.push(`${catalogName} host terminology mismatch: ${key} uses 主人`)
  }
  if (locale === 'zh' && /\bagent/i.test(englishValue) && localeValue.includes('检测剂')) {
    issues.push(`${catalogName} agent terminology mismatch: ${key} uses 检测剂`)
  }
  const expectedValue =
    REVIEWED_KEY_TRANSLATIONS.get(key)?.[locale] ?? PRODUCT_GLOSSARY.get(englishValue)?.[locale]
  if (expectedValue && localeValue !== expectedValue) {
    issues.push(`${catalogName} product terminology mismatch: ${key} must use ${expectedValue}`)
  }
  return issues
}

export function collectMobileTranslationCalls(filePath, sourceText, root = process.cwd()) {
  const sourceKind =
    filePath.endsWith('.tsx') || filePath.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    sourceKind
  )
  const calls = []
  const bindings = collectMobileTranslationBindings(sourceFile)

  function visit(node) {
    if (ts.isCallExpression(node) && isMobileTranslationCall(node, sourceFile, bindings)) {
      const keyExpression = node.arguments[0]
      if (keyExpression) {
        const prefix = mobileTranslationCallPrefix(node, sourceFile, bindings)
        const branches = collectKeyBranches(keyExpression)
        calls.push({
          ...branches,
          keys: branches.keys.map((key) => (prefix ? `${prefix}.${key}` : key)),
          location: locationFor(root, filePath, sourceFile, keyExpression),
          options: collectOptionNames(node.arguments[1]),
          source: keyExpression.getText(sourceFile)
        })
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return calls
}

function verifyCalls(calls, englishEntries) {
  const issues = []

  for (const call of calls) {
    if (!call.inspected) {
      issues.push(
        `${call.location} translation key expression is not statically inspectable: ${call.source}`
      )
      continue
    }
    if (!call.options.inspected) {
      issues.push(`${call.location} translation options are not statically inspectable`)
      continue
    }
    for (const key of call.keys) {
      const englishValue = englishEntries.get(key)
      if (englishValue === undefined) {
        issues.push(`${call.location} missing English key: ${key}`)
        continue
      }
      const placeholders = collectPlaceholderNames(englishValue)
      if (!sameValues(call.options.names, placeholders)) {
        issues.push(
          `${call.location} ${key} options [${call.options.names.join(', ')}] do not match placeholders [${placeholders.join(', ')}]`
        )
      }
    }
  }

  return issues
}

function verifyEnglishEntries(calls, englishEntries) {
  const issues = []
  const referencedKeys = new Set(calls.flatMap((call) => (call.inspected ? call.keys : [])))
  for (const [key, value] of englishEntries) {
    if (!INTENT_MESSAGE_ID_RE.test(key) || key.startsWith('m.')) {
      issues.push(`en.json message ID must be intent-named: ${key}`)
    }
    for (const placeholder of collectPlaceholderNames(value)) {
      if (POSITIONAL_PLACEHOLDER_RE.test(placeholder)) {
        issues.push(`en.json placeholder must be intent-named: ${key} uses ${placeholder}`)
      }
    }
    if (!referencedKeys.has(key)) {
      issues.push(`en.json has orphaned key: ${key}`)
    }
  }
  return issues
}

function verifyLocaleEntries(
  englishEntries,
  locale,
  localeEntries,
  catalogName = `${locale}.json`,
  requiredTranslations = REQUIRED_TARGET_TRANSLATIONS
) {
  const issues = []
  const localeKeys = [...localeEntries.keys()].sort()

  for (const key of requiredTranslations) {
    if (englishEntries.has(key) && !localeEntries.has(key)) {
      issues.push(`${catalogName} missing required translation: ${key}`)
    }
  }

  for (const key of localeKeys) {
    const englishValue = englishEntries.get(key)
    if (englishValue === undefined) {
      issues.push(`${catalogName} has extra key: ${key}`)
      continue
    }
    const englishPlaceholders = collectPlaceholderNames(englishValue)
    const localeValue = localeEntries.get(key)
    const localePlaceholders = collectPlaceholderNames(localeValue)
    if (!sameValues(englishPlaceholders, localePlaceholders)) {
      issues.push(`${catalogName} placeholder mismatch: ${key}`)
    }
    if (
      (EXACT_LANGUAGE_NEUTRAL_VALUES.has(englishValue) || EXACT_LANGUAGE_NEUTRAL_KEYS.has(key)) &&
      localeValue !== englishValue
    ) {
      issues.push(`${catalogName} must preserve language-neutral value: ${key}`)
    }
    issues.push(...verifyProtectedLiterals(englishValue, localeValue, catalogName, key))
    issues.push(...verifyTerminology(englishValue, localeValue, locale, catalogName, key))
    if (localeValue === englishValue && !isLanguageNeutralValue(englishValue, locale)) {
      issues.push(`${catalogName} copies English instead of using fallback: ${key}`)
    }
  }

  return issues
}

function findPluginOptions(expoConfig, pluginName) {
  const plugin = expoConfig.plugins?.find(
    (entry) => Array.isArray(entry) && entry[0] === pluginName
  )
  return Array.isArray(plugin) && typeof plugin[1] === 'object' && plugin[1] !== null
    ? plugin[1]
    : {}
}

function verifyNativeFallbacks(expoConfig, englishEntries) {
  const camera = findPluginOptions(expoConfig, 'expo-camera')
  const imagePicker = findPluginOptions(expoConfig, 'expo-image-picker')
  const infoPlist = expoConfig.ios?.infoPlist ?? {}
  const fallbackValues = new Map([
    ['ios.CFBundleDisplayName', [expoConfig.name]],
    ['ios.NSCameraUsageDescription', [camera.cameraPermission]],
    ['ios.NSLocalNetworkUsageDescription', [infoPlist.NSLocalNetworkUsageDescription]],
    [
      'ios.NSMicrophoneUsageDescription',
      [infoPlist.NSMicrophoneUsageDescription, camera.microphonePermission]
    ],
    [
      'ios.NSPhotoLibraryUsageDescription',
      [infoPlist.NSPhotoLibraryUsageDescription, imagePicker.photosPermission]
    ],
    ['android.app_name', [expoConfig.name]]
  ])
  const issues = []

  for (const [key, values] of fallbackValues) {
    const englishValue = englishEntries.get(key)
    for (const value of values) {
      if (typeof value !== 'string' || value !== englishValue) {
        issues.push(`mobile/app.json English native fallback mismatch: ${key}`)
        break
      }
    }
  }
  return issues
}

async function verifyNativeCatalogs(root) {
  const issues = []
  const appConfigPath = path.join(root, 'mobile', 'app.json')
  let appConfig
  try {
    appConfig = JSON.parse(await fs.readFile(appConfigPath, 'utf8'))
  } catch (error) {
    return [
      `${normalizePath(root, appConfigPath)} could not be read: ${error instanceof Error ? error.message : String(error)}`
    ]
  }

  const expoConfig = appConfig.expo ?? {}
  const configuredLocales = expoConfig.locales ?? {}
  for (const [locale, expectedPath] of NATIVE_LOCALE_PATHS) {
    if (configuredLocales[locale] !== expectedPath) {
      issues.push(`mobile/app.json locale ${locale} must map to ${expectedPath}`)
    }
  }
  for (const locale of Object.keys(configuredLocales)) {
    if (!NATIVE_LOCALE_PATHS.has(locale)) {
      issues.push(`mobile/app.json has unsupported native locale mapping: ${locale}`)
    }
  }

  const localizationPlugin = findPluginOptions(expoConfig, 'expo-localization')
  if (!sameValues(localizationPlugin.supportedLocales ?? [], NATIVE_LOCALES)) {
    issues.push('mobile/app.json expo-localization supportedLocales mismatch')
  }
  for (const [runtimeLocale, nativeLocale] of RUNTIME_TO_NATIVE_LOCALE) {
    if (!MOBILE_LOCALES.includes(runtimeLocale) || !NATIVE_LOCALE_PATHS.has(nativeLocale)) {
      issues.push(`mobile locale mapping is incomplete: ${runtimeLocale} -> ${nativeLocale}`)
    }
  }

  const nativeCatalogs = new Map()
  for (const locale of NATIVE_LOCALES) {
    const catalogPath = path.join(root, NATIVE_LOCALES_RELATIVE_DIR, `${locale}.json`)
    try {
      const flattened = flattenCatalog(
        JSON.parse(await fs.readFile(catalogPath, 'utf8')),
        `mobile/locales/${locale}.json`
      )
      nativeCatalogs.set(locale, flattened.entries)
      issues.push(...flattened.issues)
    } catch (error) {
      issues.push(
        `${normalizePath(root, catalogPath)} could not be read: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  for (const [locale, entries] of nativeCatalogs) {
    for (const key of NATIVE_REQUIRED_KEYS) {
      if (!entries.has(key)) {
        issues.push(`mobile/locales/${locale}.json missing required native key: ${key}`)
      }
    }
    for (const key of entries.keys()) {
      if (!NATIVE_REQUIRED_KEYS.includes(key)) {
        issues.push(`mobile/locales/${locale}.json has unsupported native key: ${key}`)
      }
    }
  }
  const englishEntries = nativeCatalogs.get('en')
  if (englishEntries) {
    issues.push(...verifyNativeFallbacks(expoConfig, englishEntries))
    for (const locale of NATIVE_LOCALES.slice(1)) {
      const localeEntries = nativeCatalogs.get(locale)
      if (localeEntries) {
        const runtimeLocale = locale === 'zh-Hans' ? 'zh' : locale
        issues.push(
          ...verifyLocaleEntries(
            englishEntries,
            runtimeLocale,
            localeEntries,
            `mobile/locales/${locale}.json`,
            []
          )
        )
      }
    }
  }
  return issues
}

async function readCatalogs(root) {
  const localeDirectory = path.join(root, LOCALES_RELATIVE_DIR)
  const catalogs = new Map()
  const issues = []

  for (const locale of MOBILE_LOCALES) {
    const catalogPath = path.join(localeDirectory, `${locale}.json`)
    try {
      const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'))
      const flattened = flattenCatalog(catalog, `${locale}.json`)
      catalogs.set(locale, flattened.entries)
      issues.push(...flattened.issues)
    } catch (error) {
      issues.push(
        `${normalizePath(root, catalogPath)} could not be read: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  return { catalogs, issues }
}

function reportIssues(issues) {
  console.error(`Mobile localization catalog verification failed with ${issues.length} issue(s).`)
  for (const issue of issues.slice(0, 100)) {
    console.error(issue)
  }
  if (issues.length > 100) {
    console.error(`...and ${issues.length - 100} more`)
  }
}

export async function main(root = process.cwd()) {
  const { catalogs, issues } = await readCatalogs(root)
  issues.push(...(await verifyNativeCatalogs(root)))
  const englishEntries = catalogs.get('en')
  if (!englishEntries) {
    reportIssues(issues)
    return 1
  }

  const calls = []
  for (const relativeRoot of SOURCE_RELATIVE_ROOTS) {
    const sourceRoot = path.join(root, relativeRoot)
    for (const filePath of await collectSourceFiles(sourceRoot)) {
      calls.push(
        ...collectMobileTranslationCalls(filePath, await fs.readFile(filePath, 'utf8'), root)
      )
    }
  }

  issues.push(...verifyCalls(calls, englishEntries))
  issues.push(...verifyEnglishEntries(calls, englishEntries))
  for (const locale of MOBILE_LOCALES.slice(1)) {
    const localeEntries = catalogs.get(locale)
    if (localeEntries) {
      issues.push(...verifyLocaleEntries(englishEntries, locale, localeEntries))
    }
  }

  if (issues.length > 0) {
    reportIssues(issues)
    return 1
  }
  console.log(
    `Verified ${calls.length} mobile translation calls and ${englishEntries.size} catalog keys across ${MOBILE_LOCALES.length} locales.`
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
