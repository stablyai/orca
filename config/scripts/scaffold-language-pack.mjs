import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { setLeaf, shouldPreserveEnglishValue } from './locale-translation-policy.mjs'
import {
  PLUGIN_LANGUAGE_CATALOG_MAX_VALUE_LENGTH,
  analyzeCatalog,
  deleteNestedLeaf,
  inspectCatalogShape,
  placeholdersMatch,
  protectedFromLanguagePacks,
  serializeCatalog
} from './scaffold-language-pack-catalog.mjs'
import { pluginRelativePathError } from '../../src/shared/plugins/plugin-path-safety.ts'

const DEFAULT_SOURCE = path.join('src', 'renderer', 'src', 'i18n', 'locales', 'en.json')
export const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DANGEROUS_IDS = new Set(['__proto__', 'prototype', 'constructor'])
const MANIFEST_LOCALE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/
export const PERSISTED_LANGUAGE_RE =
  /^plugin:[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i
export const ENGINE_RE = /^>=\d+\.\d+\.\d+$/

const USAGE = `Usage:
  scaffold-language-pack.mjs init --locale <tag> --publisher <slug> --id <slug> --out <dir> [options]
  scaffold-language-pack.mjs status --pack <dir> [--locale <tag>] [--source <path>] [--check] [--fix]
  scaffold-language-pack.mjs export-missing --pack <dir> --out <file> [--locale <tag>] [--source <path>] [--overwrite]
  scaffold-language-pack.mjs merge --pack <dir> --from <file> [--locale <tag>] [--source <path>] [--overwrite]`

function parseArgs(argv) {
  const [command, ...tokens] = argv
  const options = {}
  const booleanFlags = new Set(['check', 'fix', 'overwrite'])
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('--')) {
      throw new Error(`unexpected argument: ${token}`)
    }
    const name = token.slice(2)
    if (booleanFlags.has(name)) {
      options[name] = true
      continue
    }
    const value = tokens[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`${token} requires a value`)
    }
    options[name] = value
    index += 1
  }
  return { command, options }
}

function requireOption(options, name) {
  const value = options[name]
  if (typeof value !== 'string') {
    throw new Error(`--${name} is required`)
  }
  return value
}

function displayPath(root, filePath) {
  const relative = path.relative(root, filePath)
  // Why: a pack usually lives next to the checkout; "../../../tmp/x" reads worse than the absolute path.
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    return relative ? filePath : '.'
  }
  return relative.split(path.sep).join('/')
}

function validId(value) {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    ID_RE.test(value) &&
    !DANGEROUS_IDS.has(value)
  )
}

function validateInitOptions(options) {
  const locale = requireOption(options, 'locale')
  const publisher = requireOption(options, 'publisher')
  const id = requireOption(options, 'id')
  requireOption(options, 'out')
  if (!validId(id)) {
    throw new Error('--id must be a safe kebab-case slug of at most 64 characters')
  }
  if (!validId(publisher)) {
    throw new Error('--publisher must be a safe kebab-case slug of at most 64 characters')
  }
  // Why: isReservedPluginIdentity in src/shared/plugins/plugin-marketplace.ts treats both as official.
  if (id.startsWith('orca-') || publisher === 'stablyai') {
    throw new Error('--id orca-* and --publisher stablyai are reserved for official Orca plugins')
  }
  if (locale.length < 2 || locale.length > 35 || !MANIFEST_LOCALE_RE.test(locale)) {
    throw new Error('--locale is not accepted by the plugin manifest schema')
  }
  if (!PERSISTED_LANGUAGE_RE.test(`plugin:${publisher}.${id}/${locale}`)) {
    throw new Error('--locale cannot be persisted by the Orca language picker')
  }
  const catalogRelativePath = `locales/${locale}.json`
  const pathError = pluginRelativePathError(catalogRelativePath)
  if (pathError) {
    throw new Error(`--locale produces an invalid catalog path: ${pathError}`)
  }
  const name = options.name ?? languageName(locale)
  const description = options.description ?? `${name} translations for the Orca interface.`
  // Why: plugin-manifest.ts caps name at 256 and description at 4096 characters.
  if (name.length === 0 || name.length > 256) {
    throw new Error('--name must be between 1 and 256 characters')
  }
  if (description.length > 4096) {
    throw new Error('--description must be at most 4096 characters')
  }
  const engines = options.engines ?? '>=1.4.0'
  if (engines.length > 64 || !ENGINE_RE.test(engines)) {
    throw new Error('--engines must use the >=x.y.z form')
  }
  return { locale, publisher, id, engines, name, description, catalogRelativePath }
}

function languageName(locale) {
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language' }).of(locale)
    return name && name !== locale ? name : locale
  } catch {
    return locale
  }
}

async function ensureEmptyOutput(outDir) {
  try {
    const entries = await fs.readdir(outDir)
    if (entries.length > 0) {
      throw new Error(`--out already exists and is not empty: ${outDir}`)
    }
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return
    }
    throw error
  }
}

async function initPack(root, options) {
  const { locale, publisher, id, engines, name, description, catalogRelativePath } =
    validateInitOptions(options)
  const outDir = path.resolve(root, options.out)
  await ensureEmptyOutput(outDir)
  const manifest = {
    manifestVersion: 1,
    id,
    publisher,
    name,
    version: '1.0.0',
    description,
    engines: { orca: engines },
    pluginApi: 1,
    contributes: { languagePacks: [{ locale, path: catalogRelativePath }] },
    capabilities: []
  }
  await fs.mkdir(path.join(outDir, 'locales'), { recursive: true })
  // Why: keep the bundled pt-BR manifest's field order; sorting would put capabilities first.
  await fs.writeFile(
    path.join(outDir, 'orca-plugin.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  )
  await fs.writeFile(path.join(outDir, ...catalogRelativePath.split('/')), '{}\n', 'utf8')
  const shown = displayPath(root, outDir)
  console.log(`Created ${publisher}.${id} language pack at ${shown}.`)
  console.log(`Next steps:
  pnpm scaffold:language-pack status --pack ${shown}
  pnpm scaffold:language-pack export-missing --pack ${shown} --out missing.json
  pnpm scaffold:language-pack merge --pack ${shown} --from missing.json
  Test locally: Settings → Plugins → Development → Add path`)
  return 0
}

async function readJson(filePath, label) {
  let text
  try {
    text = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    throw new Error(`could not read ${label} ${filePath}: ${error.message}`)
  }
  try {
    return { value: JSON.parse(text), text }
  } catch (error) {
    throw new Error(`could not parse ${label} ${filePath}: ${error.message}`)
  }
}

function resolveContribution(manifest, requestedLocale) {
  const contributions = manifest?.contributes?.languagePacks
  if (!Array.isArray(contributions) || contributions.length === 0) {
    throw new Error('orca-plugin.json does not declare a language pack')
  }
  let contribution
  if (requestedLocale) {
    contribution = contributions.find((entry) => entry?.locale === requestedLocale)
    if (!contribution) {
      throw new Error(`manifest does not declare locale ${requestedLocale}`)
    }
  } else if (contributions.length === 1) {
    contribution = contributions[0]
  } else {
    throw new Error('--locale is required when the manifest declares multiple language packs')
  }
  if (typeof contribution.path !== 'string' || typeof contribution.locale !== 'string') {
    throw new Error('manifest language pack contribution is malformed')
  }
  return contribution
}

async function containedCatalogPath(packDir, relativePath) {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
    throw new Error('manifest language pack path must stay inside the plugin directory')
  }
  const resolved = path.resolve(packDir, ...relativePath.split(/[\\/]/))
  const fromPack = path.relative(packDir, resolved)
  if (fromPack === '..' || fromPack.startsWith(`..${path.sep}`) || path.isAbsolute(fromPack)) {
    throw new Error('manifest language pack path must stay inside the plugin directory')
  }
  let packReal
  let catalogReal
  try {
    packReal = await fs.realpath(packDir)
    catalogReal = await fs.realpath(resolved)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error('language pack catalog not found')
    }
    throw error
  }
  const fromRealPack = path.relative(packReal, catalogReal)
  if (
    fromRealPack === '..' ||
    fromRealPack.startsWith(`..${path.sep}`) ||
    path.isAbsolute(fromRealPack)
  ) {
    throw new Error('manifest language pack path must stay inside the plugin directory')
  }
  const catalogStat = await fs.stat(catalogReal)
  if (!catalogStat.isFile()) {
    throw new Error('language pack catalog is not a regular file')
  }
  return catalogReal
}

async function loadPack(root, options) {
  const packDir = path.resolve(root, requireOption(options, 'pack'))
  const manifest = (await readJson(path.join(packDir, 'orca-plugin.json'), 'manifest')).value
  const contribution = resolveContribution(manifest, options.locale)
  const catalogPath = await containedCatalogPath(packDir, contribution.path)
  const catalogFile = await readJson(catalogPath, 'language pack')
  const sourcePath = path.resolve(root, options.source ?? DEFAULT_SOURCE)
  const source = await readJson(sourcePath, 'English catalog')
  const sourceShape = inspectCatalogShape(source.value, Buffer.byteLength(source.text))
  if (sourceShape.findings.length > 0) {
    throw new Error(`English catalog ${sourcePath} is malformed: ${sourceShape.findings[0]}`)
  }
  return {
    packDir,
    locale: contribution.locale,
    catalogPath,
    catalog: catalogFile.value,
    catalogText: catalogFile.text,
    source: source.value
  }
}

function printList(label, entries) {
  for (const entry of entries.slice(0, 20)) {
    console.log(`${label}: ${entry}`)
  }
  if (entries.length > 20) {
    console.log(`...and ${entries.length - 20} more`)
  }
}

function reportStatus(locale, analysis) {
  const coverage =
    analysis.required.size === 0 ? 100 : (analysis.translated.length / analysis.required.size) * 100
  console.log(
    `Language pack ${locale}: ${analysis.translated.length}/${analysis.required.size} required keys (${coverage.toFixed(1)}% coverage), ${analysis.missing.length} missing, ${analysis.retired.length} retired, ${analysis.copiedEnglish.length} copied English.`
  )
  for (const [label, entries] of [
    ['missing', analysis.missing],
    ['retired', analysis.retired],
    ['copied English', analysis.copiedEnglish],
    ['protected', analysis.protected],
    ['oversize', analysis.oversize],
    ['placeholder mismatch', analysis.placeholderMismatch],
    ['catalog limit', analysis.limit]
  ]) {
    printList(label, entries)
  }
}

function hasCheckFailures(analysis) {
  return (
    analysis.protected.length > 0 ||
    analysis.oversize.length > 0 ||
    analysis.placeholderMismatch.length > 0 ||
    analysis.limit.length > 0
  )
}

async function statusPack(root, options) {
  const loaded = await loadPack(root, options)
  let analysis = analyzeCatalog(
    loaded.source,
    loaded.catalog,
    Buffer.byteLength(loaded.catalogText)
  )
  reportStatus(loaded.locale, analysis)
  if (options.fix) {
    const removable = [
      ...new Set([...analysis.retired, ...analysis.protected, ...analysis.oversize])
    ]
    for (const key of removable) {
      deleteNestedLeaf(loaded.catalog, key)
    }
    const serialized = serializeCatalog(loaded.catalog)
    await fs.writeFile(loaded.catalogPath, serialized, 'utf8')
    printList('removed', removable)
    console.log(`Removed ${removable.length} entries and rewrote the catalog.`)
    analysis = analyzeCatalog(loaded.source, loaded.catalog, Buffer.byteLength(serialized))
  }
  return options.check && hasCheckFailures(analysis) ? 1 : 0
}

async function exportMissing(root, options) {
  const loaded = await loadPack(root, options)
  const outputPath = path.resolve(root, requireOption(options, 'out'))
  const analysis = analyzeCatalog(
    loaded.source,
    loaded.catalog,
    Buffer.byteLength(loaded.catalogText)
  )
  const missing = {}
  for (const key of analysis.missing) {
    setLeaf(missing, key, analysis.required.get(key))
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  try {
    // Why: 'wx' makes the no-overwrite guarantee atomic instead of check-then-write.
    await fs.writeFile(outputPath, serializeCatalog(missing), {
      encoding: 'utf8',
      flag: options.overwrite ? 'w' : 'wx'
    })
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') {
      throw new Error(`refusing to overwrite ${displayPath(root, outputPath)} without --overwrite`)
    }
    throw error
  }
  if (analysis.missing.length === 0) {
    console.log(`Language pack ${loaded.locale}: nothing missing.`)
  } else {
    console.log(
      `Exported ${analysis.missing.length} missing keys to ${displayPath(root, outputPath)}.`
    )
  }
  return 0
}

function increment(rejections, reason) {
  rejections[reason] = (rejections[reason] ?? 0) + 1
}

async function mergePack(root, options) {
  const loaded = await loadPack(root, options)
  const fromPath = path.resolve(root, requireOption(options, 'from'))
  const incomingFile = await readJson(fromPath, 'merge catalog')
  const shape = inspectCatalogShape(incomingFile.value, Buffer.byteLength(incomingFile.text))
  if (shape.findings.length > 0) {
    printList('rejected malformed', shape.findings)
    return 1
  }
  const incoming = analyzeCatalog(loaded.source, incomingFile.value).packLeaves
  const loadedAnalysis = analyzeCatalog(loaded.source, loaded.catalog)
  const existing = loadedAnalysis.packLeaves
  const englishLeaves = loadedAnalysis.englishLeaves
  const rejections = {}
  let merged = 0
  let keptExisting = 0
  let fatal = false
  for (const [key, value] of incoming) {
    const english = englishLeaves.get(key)
    let reason
    if (english === undefined) {
      reason = 'unknown'
    } else if (protectedFromLanguagePacks(key)) {
      reason = 'protected'
      fatal = true
    } else if (value.length > PLUGIN_LANGUAGE_CATALOG_MAX_VALUE_LENGTH) {
      reason = 'oversize'
    } else if (!value.trim()) {
      reason = 'empty'
    } else if (!placeholdersMatch(english, value)) {
      reason = 'placeholder mismatch'
      fatal = true
    } else if (value === english && !shouldPreserveEnglishValue(english, key)) {
      reason = 'copied English'
    }
    if (reason) {
      increment(rejections, reason)
      continue
    }
    if (existing.has(key) && !options.overwrite) {
      keptExisting += 1
      continue
    }
    setLeaf(loaded.catalog, key, value)
    merged += 1
  }
  const serialized = serializeCatalog(loaded.catalog)
  const mergedShape = inspectCatalogShape(loaded.catalog, Buffer.byteLength(serialized))
  if (mergedShape.findings.length > 0) {
    printList('rejected merged catalog', mergedShape.findings)
    return 1
  }
  await fs.writeFile(loaded.catalogPath, serialized, 'utf8')
  console.log(`Merge result: ${merged} merged, ${keptExisting} kept existing.`)
  for (const reason of [
    'unknown',
    'protected',
    'oversize',
    'empty',
    'placeholder mismatch',
    'copied English'
  ]) {
    console.log(`Rejected ${reason}: ${rejections[reason] ?? 0}`)
  }
  return fatal ? 1 : 0
}

export async function main(root = process.cwd(), argv = process.argv.slice(2)) {
  try {
    const { command, options } = parseArgs(argv)
    if (command === 'init') {
      return await initPack(root, options)
    }
    if (command === 'status') {
      requireOption(options, 'pack')
      return await statusPack(root, options)
    }
    if (command === 'export-missing') {
      requireOption(options, 'pack')
      requireOption(options, 'out')
      return await exportMissing(root, options)
    }
    if (command === 'merge') {
      requireOption(options, 'pack')
      requireOption(options, 'from')
      return await mergePack(root, options)
    }
    console.error(USAGE)
    return 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(USAGE)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
