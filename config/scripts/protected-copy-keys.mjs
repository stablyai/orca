// Generates the translation keys no plugin language pack may replace, from markers in source.
// Usage: node config/scripts/protected-copy-keys.mjs [--fix]
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { collectSourceFiles, LOCALIZATION_SOURCE_ROOTS } from './verify-localization-catalog.mjs'
import { collectKeyLiterals } from './verify-localization-extraction.mjs'

export const PROTECTED_COPY_KEYS_PATH = path.join(
  'src',
  'shared',
  'plugins',
  'languages',
  'protected-copy-keys.json'
)
const EN_CATALOG_PATH = path.join('src', 'renderer', 'src', 'i18n', 'locales', 'en.json')
const SYNC_COMMAND = 'pnpm run sync:localization-protected-copy'

const SECURITY_SURFACE_RE =
  /surface=["']security["']|surface:\s*["']security["']|<SecuritySurface\b/
const DESTRUCTIVE_CONTROL_RE = /variant=["']destructive["']|variant:\s*["']destructive["']/
const CONFIRMATION_DIALOG_RE = /<(?:Alert)?Dialog(?:Content|Footer)\b/
const NATIVE_MESSAGE_BOX_RE = /\bshowMessageBox(?:Sync)?\(/
const PROTECTED_COPY_PRAGMA_RE = /^\s*\/\/ @protected-copy\b/m
const RELATIVE_IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"](\.\/[^'"]+)['"]/g
const PLURAL_SUFFIX_RE = /_(?:zero|one|two|few|many|other)$/
const RESOLVE_EXTENSIONS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']

/** Why a file's strings are protected, or null. */
export function protectedCopyMarker(sourceText) {
  if (SECURITY_SURFACE_RE.test(sourceText)) {
    return 'security surface'
  }
  if (CONFIRMATION_DIALOG_RE.test(sourceText) && DESTRUCTIVE_CONTROL_RE.test(sourceText)) {
    return 'destructive confirmation'
  }
  if (NATIVE_MESSAGE_BOX_RE.test(sourceText)) {
    return 'native message box'
  }
  return PROTECTED_COPY_PRAGMA_RE.test(sourceText) ? 'pragma' : null
}

function flattenCatalog(value, prefix = '', paths = new Set()) {
  for (const [key, child] of Object.entries(value)) {
    const childPath = prefix ? `${prefix}.${key}` : key
    paths.add(childPath)
    if (typeof child === 'object' && child !== null) {
      flattenCatalog(child, childPath, paths)
    }
  }
  return paths
}

// Why same-directory only: a dialog's copy module and split-out footer sit beside it; deeper
// imports reach shared chrome that carries no trust meaning.
function siblingImports(filePath, sourceText) {
  const imports = []
  for (const match of sourceText.matchAll(RELATIVE_IMPORT_RE)) {
    const base = path.resolve(path.dirname(filePath), match[1])
    const resolved = RESOLVE_EXTENSIONS.map((extension) => base + extension).find(
      (candidate) => existsSync(candidate) && !candidate.endsWith('.json')
    )
    if (resolved && path.dirname(resolved) === path.dirname(filePath)) {
      imports.push(resolved)
    }
  }
  return imports
}

/** Keys and dynamic key prefixes referenced by marked files and their sibling imports. */
export function collectProtectedCopyKeys(sources, englishPaths) {
  const marked = [...sources.keys()].filter((file) => protectedCopyMarker(sources.get(file)))
  const files = new Set(marked)
  for (const file of marked) {
    for (const imported of siblingImports(file, sources.get(file))) {
      if (sources.has(imported)) {
        files.add(imported)
      }
    }
  }
  const evidence = { literals: new Set(), dynamicPrefixes: new Set() }
  for (const file of files) {
    collectKeyLiterals(sources.get(file), evidence)
  }
  const keys = new Set()
  for (const literal of evidence.literals) {
    const key = literal.replace(PLURAL_SUFFIX_RE, '')
    if (englishPaths.has(key) || englishPaths.has(`${key}_other`)) {
      keys.add(key)
    }
  }
  // Why two segments: a bare `auto.` head would protect the whole catalog.
  const prefixes = [...evidence.dynamicPrefixes].filter((prefix) => {
    const segments = prefix.split('.').filter(Boolean)
    return segments.length >= 2 && [...englishPaths].some((key) => key.startsWith(prefix))
  })
  return { keys: [...keys].sort(), prefixes: [...new Set(prefixes)].sort() }
}

async function readSources(root) {
  const sources = new Map()
  for (const sourceRoot of LOCALIZATION_SOURCE_ROOTS) {
    for (const file of await collectSourceFiles(root, path.join(root, sourceRoot))) {
      sources.set(file, await fs.readFile(file, 'utf8'))
    }
  }
  return sources
}

export async function main(root = process.cwd(), args = process.argv.slice(2)) {
  const english = JSON.parse(await fs.readFile(path.join(root, EN_CATALOG_PATH), 'utf8'))
  const generated = collectProtectedCopyKeys(await readSources(root), flattenCatalog(english))
  const expected = `${JSON.stringify(generated, null, 2)}\n`
  const outputPath = path.join(root, PROTECTED_COPY_KEYS_PATH)
  if (args.includes('--fix')) {
    await fs.writeFile(outputPath, expected)
    console.log(`Wrote ${generated.keys.length} protected copy keys to ${PROTECTED_COPY_KEYS_PATH}`)
    return 0
  }
  const current = await fs.readFile(outputPath, 'utf8').catch(() => '')
  if (current !== expected) {
    console.error(
      `${PROTECTED_COPY_KEYS_PATH} is stale: security dialogs, destructive confirmations, or @protected-copy files changed their translation keys. Run \`${SYNC_COMMAND}\`.`
    )
    return 1
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
