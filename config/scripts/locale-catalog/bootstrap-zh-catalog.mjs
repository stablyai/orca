import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { main as bootstrapLocaleCatalog } from './bootstrap-locale-catalog.mjs'

export async function main(root = process.cwd()) {
  return bootstrapLocaleCatalog(root, 'zh')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
