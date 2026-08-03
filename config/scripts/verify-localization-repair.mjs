import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { countCatalogRepairDrifts } from './locale-translation-policy.mjs'

const LOCALES_DIR = path.join('src', 'renderer', 'src', 'i18n', 'locales')

// CJK locales are kept repair-clean under the translation policy. Spanish still carries bulk MT
// drift (hundreds of leaves); do not gate es until a dedicated es repair pass lands.
const REPAIR_GATED_LOCALES = ['ko', 'ja', 'zh']

function parseLocales(argv) {
  const localeFlagIndex = argv.indexOf('--locale')
  if (localeFlagIndex !== -1 && argv[localeFlagIndex + 1]) {
    return [argv[localeFlagIndex + 1]]
  }
  return REPAIR_GATED_LOCALES
}

export async function main(root = process.cwd(), locales = parseLocales(process.argv)) {
  const unsupported = locales.filter((code) => !REPAIR_GATED_LOCALES.includes(code))
  if (unsupported.length > 0) {
    console.error(
      `Unsupported locale(s) for repair gate: ${unsupported.join(', ')}. Gated: ${REPAIR_GATED_LOCALES.join(', ')}`
    )
    return 1
  }

  const enCatalog = JSON.parse(await fs.readFile(path.join(root, LOCALES_DIR, 'en.json'), 'utf8'))
  let failed = false

  for (const locale of locales) {
    const localePath = path.join(root, LOCALES_DIR, `${locale}.json`)
    const localeCatalog = JSON.parse(await fs.readFile(localePath, 'utf8'))
    const drifts = countCatalogRepairDrifts(enCatalog, localeCatalog, locale)
    if (drifts > 0) {
      failed = true
      console.error(
        `${locale}.json is ${drifts} leaf(ves) behind locale-translation-policy. Run:\n` +
          `  node config/scripts/repair-locale-catalog.mjs --locale ${locale}`
      )
    } else {
      console.log(`${locale}.json agrees with locale-translation-policy`)
    }
  }

  return failed ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
