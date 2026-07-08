import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import * as OpenCC from 'opencc-js'

import { collectStringLeaves, repairCatalog, setLeaf } from './locale-translation-policy.mjs'

const LOCALES_DIR = path.join('src', 'renderer', 'src', 'i18n', 'locales')

// Why: zh.json already carries every curated glossary/brand/phrase repair, so zh-TW
// is derived from it via OpenCC (cn→twp Taiwan phrasing) instead of re-machine-translated.
export async function main(root = process.cwd()) {
  const enCatalog = JSON.parse(await fs.readFile(path.join(root, LOCALES_DIR, 'en.json'), 'utf8'))
  const zhCatalog = JSON.parse(await fs.readFile(path.join(root, LOCALES_DIR, 'zh.json'), 'utf8'))
  const localeCatalog = structuredClone(enCatalog)
  const convert = OpenCC.Converter({ from: 'cn', to: 'twp' })
  const zhValues = new Map(collectStringLeaves(zhCatalog).map((leaf) => [leaf.key, leaf.value]))

  let converted = 0
  let keptEnglish = 0
  for (const leaf of collectStringLeaves(enCatalog)) {
    const zhValue = zhValues.get(leaf.key)
    // Keys not yet translated in zh.json keep their English value, matching the
    // parity-repair behavior of sync:localization-catalog for every locale.
    if (typeof zhValue === 'string' && zhValue !== leaf.value) {
      setLeaf(localeCatalog, leaf.key, convert(zhValue))
      converted += 1
    } else {
      setLeaf(localeCatalog, leaf.key, leaf.value)
      keptEnglish += 1
    }
  }

  // repairCatalog applies the full zh-TW repair policy (brand fixes, CJK spacing,
  // picker/menu labels) over the converted values in one pass.
  const repaired = repairCatalog(enCatalog, localeCatalog, 'zh-TW')

  const localePath = path.join(root, LOCALES_DIR, 'zh-TW.json')
  await fs.writeFile(localePath, `${JSON.stringify(localeCatalog, null, 2)}\n`, 'utf8')
  console.log(
    `Converted ${converted} strings from zh.json (${keptEnglish} kept English, ${repaired} policy repairs); wrote ${localePath}`
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
