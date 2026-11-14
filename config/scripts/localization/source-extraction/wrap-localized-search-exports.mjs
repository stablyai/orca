import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const RENDERER_SRC = path.join(ROOT, 'src', 'renderer', 'src')
const LOCALIZED_CATALOG_IMPORT =
  "import { createLocalizedCatalog } from '@/i18n/localized-catalog'\n"

function getterName(exportName) {
  if (exportName.endsWith('_ENTRIES')) {
    const stem = exportName.slice(0, -'_ENTRIES'.length)
    return `get${stem
      .toLowerCase()
      .split('_')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('')}Entries`
  }
  if (exportName.endsWith('_ENTRY')) {
    const stem = exportName.slice(0, -'_ENTRY'.length)
    return `get${stem
      .toLowerCase()
      .split('_')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('')}Entry`
  }
  if (exportName === 'STATUS_BAR_TOGGLES') {
    return 'getStatusBarToggles'
  }
  return `get${exportName
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')}`
}

function wrapExportConst(sourceText) {
  const exportPattern =
    /export const ([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*(\[[\s\S]*?\]|{[\s\S]*?})\s*(?=\n(?:export |$))/g
  const replacements = []
  let match

  while ((match = exportPattern.exec(sourceText)) !== null) {
    const [fullMatch, exportName, value] = match
    if (!value.includes('translate(')) {
      continue
    }
    const getter = getterName(exportName)
    const wrapped = `export const ${getter} = createLocalizedCatalog(() => ${value.trim()})`
    replacements.push({ exportName, getter, fullMatch, wrapped })
  }

  if (replacements.length === 0) {
    return { sourceText, replacements: [] }
  }

  let next = sourceText
  for (const replacement of replacements.sort((a, b) => b.fullMatch.length - a.fullMatch.length)) {
    next = next.replace(replacement.fullMatch, `${replacement.wrapped}\n`)
  }

  if (!next.includes("from '@/i18n/localized-catalog'")) {
    const translateImport = next.match(/^import[\s\S]*?from\s*['"]@\/i18n\/i18n['"]\n/m)
    if (translateImport) {
      const insertAt = (translateImport.index ?? 0) + translateImport[0].length
      next = `${next.slice(0, insertAt)}${LOCALIZED_CATALOG_IMPORT}${next.slice(insertAt)}`
    } else {
      next = `${LOCALIZED_CATALOG_IMPORT}${next}`
    }
  }

  return { sourceText: next, replacements }
}

async function collectFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', 'out', 'assets', '__snapshots__'].includes(entry.name)) {
        files.push(...(await collectFiles(fullPath)))
      }
      continue
    }
    if (
      entry.isFile() &&
      /\.(?:ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.includes('.test.') &&
      !entry.name.includes('.spec.')
    ) {
      files.push(fullPath)
    }
  }
  return files
}

async function main() {
  const files = await collectFiles(RENDERER_SRC)
  const mapping = new Map()

  for (const filePath of files) {
    const sourceText = await fs.readFile(filePath, 'utf8')
    const { sourceText: next, replacements } = wrapExportConst(sourceText)
    if (replacements.length === 0) {
      continue
    }
    await fs.writeFile(filePath, next)
    for (const replacement of replacements) {
      mapping.set(replacement.exportName, replacement.getter)
    }
    console.log(`wrapped ${replacements.length} exports in ${path.relative(ROOT, filePath)}`)
  }

  const allFiles = await collectFiles(path.join(ROOT, 'src'))
  for (const filePath of allFiles) {
    let sourceText = await fs.readFile(filePath, 'utf8')
    let changed = false
    for (const [exportName, getter] of mapping.entries()) {
      const pattern = new RegExp(`\\b${exportName}\\b`, 'g')
      const next = sourceText.replace(pattern, `${getter}()`)
      if (next !== sourceText) {
        sourceText = next
        changed = true
      }
    }
    if (changed) {
      await fs.writeFile(filePath, sourceText)
      console.log(`updated references in ${path.relative(ROOT, filePath)}`)
    }
  }
}

await main()
