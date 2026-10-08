import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const TOOLCHAIN_FILES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  '.npmrc',
  '.pnpmfile.cjs',
  '.github/workflows/pr.yml'
])

function isIgnoredTestSource(path) {
  if (!/\.(?:js|jsx|ts|tsx|mts|cts)$/.test(path)) {
    return false
  }
  const segments = path.split('/')
  const filename = segments.at(-1) ?? ''
  return (
    filename.includes('.test.') ||
    filename.includes('.spec.') ||
    segments.slice(0, -1).some((segment) => segment === '__tests__' || segment === '__snapshots__')
  )
}

export function affectsLocalizationExtraction(paths) {
  return paths.some(
    (path) =>
      TOOLCHAIN_FILES.has(path) ||
      // Keep catalogs and future source inputs; skip only configured test exclusions.
      (path.startsWith('src/') && !isIgnoredTestSource(path)) ||
      path.startsWith('config/i18next.') ||
      path.startsWith('config/tsconfig') ||
      path.startsWith('config/patches/') ||
      path.startsWith('config/scripts/localization-') ||
      path.startsWith('config/scripts/verify-localization-') ||
      path.startsWith('.github/actions/install-node-dependencies/')
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const changed = readFileSync(process.argv[2], 'utf8').split('\0').filter(Boolean)
  process.stdout.write(`${affectsLocalizationExtraction(changed)}\n`)
}
