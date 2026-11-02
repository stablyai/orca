import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Plugin } from 'rolldown'

// Main only localizes menus, dialogs and notifications; whole renderer catalogs cost ~1 MB per locale.
const LOCALES_DIR = resolve('src/renderer/src/i18n/locales')
const KEY_SOURCE_ROOTS = ['src/main', 'src/shared']
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'])
const PLURAL_SUFFIX_RE = /_(?:zero|one|two|few|many|other)$/

type KeyEvidence = { literals: Set<string>; dynamicPrefixes: Set<string> }
type Catalog = { [key: string]: string | Catalog }
type CatalogScript = { collectSourceFiles: (root: string, dir: string) => Promise<string[]> }
type ExtractionScript = {
  collectKeyLiterals: (source: string, evidence: KeyEvidence) => KeyEvidence
}

function scriptUrl(name: string): string {
  return pathToFileURL(resolve('config/scripts', name)).href
}

function isLocaleCatalog(id: string): boolean {
  const relativePath = relative(LOCALES_DIR, id)
  return !relativePath.startsWith('..') && !relativePath.includes(sep) && id.endsWith('.json')
}

function isNamed(key: string, evidence: KeyEvidence): boolean {
  // Literals are stored without plural suffixes, so key_few ships whenever key_one is named.
  return (
    evidence.literals.has(key.replace(PLURAL_SUFFIX_RE, '')) ||
    [...evidence.dynamicPrefixes].some((prefix) => key.startsWith(prefix))
  )
}

function pickNamedEntries(catalog: Catalog, evidence: KeyEvidence, prefix = ''): Catalog {
  const picked: Catalog = {}
  for (const [name, value] of Object.entries(catalog)) {
    const key = prefix ? `${prefix}.${name}` : name
    if (typeof value === 'string') {
      if (isNamed(key, evidence)) {
        picked[name] = value
      }
      continue
    }
    const child = pickNamedEntries(value, evidence, key)
    if (Object.keys(child).length > 0) {
      picked[name] = child
    }
  }
  return picked
}

function stripPluralLiterals(evidence: KeyEvidence): KeyEvidence {
  return {
    literals: new Set([...evidence.literals].map((key) => key.replace(PLURAL_SUFFIX_RE, ''))),
    dynamicPrefixes: evidence.dynamicPrefixes
  }
}

/** Ships main only the catalog keys main-process source names; missing keys fall back to English. */
export function createMainLocaleSubsetPlugin(): Plugin {
  let evidence: KeyEvidence | undefined
  let collectKeyLiterals: ExtractionScript['collectKeyLiterals'] | undefined

  return {
    name: 'orca-main-locale-subset',
    async buildStart() {
      // Watch builds skip subsetting so keys added during dev are never stale.
      if (this.meta.watchMode) {
        evidence = undefined
        return
      }
      // Runtime URLs keep the CLI scripts (top-level await) out of the CommonJS config bundle.
      const [catalogScript, extractionScript]: [CatalogScript, ExtractionScript] =
        await Promise.all([
          import(scriptUrl('verify-localization-catalog.mjs')),
          import(scriptUrl('verify-localization-extraction.mjs'))
        ])
      collectKeyLiterals = extractionScript.collectKeyLiterals
      const collected: KeyEvidence = { literals: new Set(), dynamicPrefixes: new Set() }
      for (const sourceRoot of KEY_SOURCE_ROOTS) {
        for (const file of await catalogScript.collectSourceFiles(
          process.cwd(),
          resolve(sourceRoot)
        )) {
          collectKeyLiterals(await readFile(file, 'utf8'), collected)
        }
      }
      evidence = stripPluralLiterals(collected)
    },
    async load(id) {
      if (!evidence || !isLocaleCatalog(id)) {
        return null
      }
      const catalog: Catalog = JSON.parse(await readFile(id, 'utf8'))
      return JSON.stringify(pickNamedEntries(catalog, evidence))
    },
    async buildEnd(error) {
      if (error || !evidence || !collectKeyLiterals) {
        return
      }
      // Bundled modules outside the scanned roots must not name keys the subset dropped.
      const outside: KeyEvidence = { literals: new Set(), dynamicPrefixes: new Set() }
      for (const id of this.getModuleIds()) {
        const relativePath = relative(process.cwd(), id)
        if (
          isAbsolute(id) &&
          !relativePath.startsWith('..') &&
          !relativePath.split(sep).includes('node_modules') &&
          SOURCE_EXTENSIONS.has(extname(id)) &&
          !KEY_SOURCE_ROOTS.some((root) => relativePath.startsWith(join(root, sep)))
        ) {
          collectKeyLiterals(await readFile(id, 'utf8'), outside)
        }
      }
      const english: Catalog = JSON.parse(await readFile(join(LOCALES_DIR, 'en.json'), 'utf8'))
      const outsideNames = stripPluralLiterals(outside)
      const shipped = evidence
      const dropped = catalogKeys(english).filter(
        (key) => isNamed(key, outsideNames) && !isNamed(key, shipped)
      )
      if (dropped.length > 0) {
        this.error(
          `Main bundles modules outside ${KEY_SOURCE_ROOTS.join(', ')} that name localization keys; add their directory to KEY_SOURCE_ROOTS: ${dropped.join(', ')}`
        )
      }
    }
  }
}

function catalogKeys(catalog: Catalog, prefix = ''): string[] {
  return Object.entries(catalog).flatMap(([name, value]) => {
    const key = prefix ? `${prefix}.${name}` : name
    return typeof value === 'string' ? [key] : catalogKeys(value, key)
  })
}
