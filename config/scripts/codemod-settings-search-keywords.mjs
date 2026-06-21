import fs from 'node:fs/promises'
import path from 'node:path'

const SETTINGS_DIR = path.join('src', 'renderer', 'src', 'components', 'settings')
const IMPORT_LINE = "import { translateSearchKeyword } from './settings-search-keywords'"

function transformKeywordsBlock(block) {
  return block.replace(
    /(?<!\.\.\.)translate\((['"`])([^'"`]+)\1,\s*(['"`])([^'"`]*)\3\)/g,
    '...translateSearchKeyword($1$2$1, $3$4$3)'
  )
}

function transformFile(content) {
  if (!content.includes('keywords:') || content.includes('translateSearchKeyword')) {
    return content
  }

  let next = content.replace(/keywords:\s*\[([\s\S]*?)\]/g, (match, body) => {
    const transformedBody = transformKeywordsBlock(body)
    return transformedBody === body ? match : `keywords: [${transformedBody}]`
  })

  if (next === content) {
    return content
  }

  if (!next.includes(IMPORT_LINE)) {
    const i18nImport = "import { translate } from '@/i18n/i18n'"
    next = next.includes(i18nImport)
      ? next.replace(i18nImport, `${i18nImport}\n${IMPORT_LINE}`)
      : `${IMPORT_LINE}\n${next}`
  }

  return next
}

async function main() {
  const entries = await fs.readdir(SETTINGS_DIR)
  const files = entries
    .filter((name) => name.endsWith('-search.ts'))
    .map((name) => path.join(SETTINGS_DIR, name))

  let changed = 0
  for (const filePath of files) {
    const original = await fs.readFile(filePath, 'utf8')
    const updated = transformFile(original)
    if (updated !== original) {
      await fs.writeFile(filePath, updated, 'utf8')
      changed += 1
      console.log(`Updated ${filePath}`)
    }
  }

  console.log(`Codemod complete (${changed} files).`)
}

await main()
