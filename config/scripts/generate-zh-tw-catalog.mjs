import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

import OpenCC from 'opencc-js'

const SOURCE_CATALOG_PATH = path.join('src', 'renderer', 'src', 'i18n', 'locales', 'zh.json')
const OUTPUT_CATALOG_PATH = path.join('src', 'renderer', 'src', 'i18n', 'locales', 'zh-TW.json')
const INTERPOLATION_PART_RE = /(\{\{[^{}]+\}\})/g
const WHOLE_INTERPOLATION_RE = /^\{\{[^{}]+\}\}$/
const toTraditionalChinese = OpenCC.Converter({ from: 'cn', to: 'tw' })

export function convertSimplifiedText(value) {
  // Why: interpolation identifiers are an application contract, not user-visible copy.
  return value
    .split(INTERPOLATION_PART_RE)
    .map((part) => (WHOLE_INTERPOLATION_RE.test(part) ? part : toTraditionalChinese(part)))
    .join('')
}

export function convertSimplifiedCatalog(value) {
  if (typeof value === 'string') {
    return convertSimplifiedText(value)
  }
  if (Array.isArray(value)) {
    return value.map((item) => convertSimplifiedCatalog(item))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, convertSimplifiedCatalog(child)])
    )
  }
  return value
}

export function serializeCatalog(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`
}

async function expectedCatalogText(root) {
  const source = JSON.parse(await fs.readFile(path.join(root, SOURCE_CATALOG_PATH), 'utf8'))
  return serializeCatalog(convertSimplifiedCatalog(source))
}

export async function main(root = process.cwd(), argv = process.argv.slice(2)) {
  const write = argv.includes('--write')
  const check = argv.includes('--check')
  if (write === check) {
    console.error('Pass exactly one of --write or --check.')
    return 1
  }

  const outputPath = path.join(root, OUTPUT_CATALOG_PATH)
  const expected = await expectedCatalogText(root)

  if (write) {
    await fs.writeFile(outputPath, expected, 'utf8')
    console.log(`Generated ${OUTPUT_CATALOG_PATH} from ${SOURCE_CATALOG_PATH}.`)
    return 0
  }

  let actual
  try {
    actual = await fs.readFile(outputPath, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error
    }
  }

  if (actual !== expected) {
    console.error(`${OUTPUT_CATALOG_PATH} is stale or missing.`)
    console.error('Run `pnpm run generate:zh-tw-catalog` and commit the generated catalog.')
    return 1
  }

  console.log(`Verified ${OUTPUT_CATALOG_PATH} is generated from ${SOURCE_CATALOG_PATH}.`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
