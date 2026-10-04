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

export function affectsLocalizationExtraction(paths) {
  return paths.some(
    (path) =>
      TOOLCHAIN_FILES.has(path) ||
      // Include all source paths so catalog moves and future extractor inputs stay covered.
      path.startsWith('src/') ||
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
