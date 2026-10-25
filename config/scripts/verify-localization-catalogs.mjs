import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  collectLocalizationReferences,
  main as verifyCatalog
} from './verify-localization-catalog.mjs'
import { main as verifyRuntimeCatalog } from './generate-runtime-required-english-catalog.mjs'

export async function main(root = process.cwd()) {
  // Share only this invocation's scan, never cached evidence from another checkout.
  const references = await collectLocalizationReferences(root)
  const results = await Promise.allSettled([
    verifyCatalog(root, {}, references),
    verifyRuntimeCatalog(root, [], references)
  ])
  let exitCode = 0
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error(result.reason)
      exitCode = 1
    } else if (result.value !== 0) {
      exitCode = 1
    }
  }
  return exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
