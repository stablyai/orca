import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  collectProcessHostSources,
  main as checkProcessHostImports
} from './check-process-host-imports.mjs'
import { main as checkCompatBoundaryImports } from './check-compat-boundary-imports.mjs'
import { collectModuleSpecifiers } from '../module-requests/static-module-specifiers.mjs'
import { isTestOnlySourcePath } from './test-only-source-path.mjs'

function checkSharedReactImports(sources, specifiersFor, parseSpecifiers) {
  const isReact = (name) => /^react(?:-dom)?(?:\/|$)/.test(name)
  const violations = []
  for (const [file, contents] of sources) {
    if (
      !file.startsWith('src/shared/') ||
      isTestOnlySourcePath(file) ||
      !specifiersFor(file, contents).some(isReact)
    ) {
      continue
    }
    for (const name of parseSpecifiers(file, contents, { runtimeOnly: true }).filter(isReact)) {
      violations.push(`${file}: move the runtime ${name} import into the client`)
    }
  }
  if (violations.length > 0) {
    console.error(`[shared-react-imports]\n${violations.join('\n')}`)
    return 1
  }
  console.log('[shared-react-imports] ok')
  return 0
}

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
  const sharedReact = checkSharedReactImports(sources, specifiersFor, parseSpecifiers)
  return Math.max(processHost, compatibility, sharedReact)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main()
}
