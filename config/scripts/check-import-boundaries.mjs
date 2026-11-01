import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  collectProcessHostSources,
  main as checkProcessHostImports
} from './check-process-host-imports.mjs'
import { main as checkCompatBoundaryImports } from './check-compat-boundary-imports.mjs'
import { collectModuleSpecifiers } from './static-module-specifiers.mjs'

export function main(
  root = process.cwd(),
  { collectSources = collectProcessHostSources, parseSpecifiers = collectModuleSpecifiers } = {}
) {
  const sources = collectSources(root)
  // These results belong only to this immutable source inventory and this invocation.
  const specifiers = new Map()
  const specifiersFor = (file, contents) => {
    if (!specifiers.has(file)) {
      specifiers.set(file, parseSpecifiers(file, contents))
    }
    return specifiers.get(file)
  }
  const processHost = checkProcessHostImports(root, sources, specifiersFor)
  const compatibility = checkCompatBoundaryImports(root, sources, specifiersFor)
  return Math.max(processHost, compatibility)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main()
}
