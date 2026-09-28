import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { classifyBunProfileChanges, collectBunProfileInputs } from './bun-profile-change-scope.mjs'
import { ORCAD_CHILD_ENTRY_POINTS, ORCAD_ENTRY_POINT } from './orcad-entry-build.mjs'

const ENTRY_POINTS = [
  ORCAD_ENTRY_POINT,
  ...Object.values(ORCAD_CHILD_ENTRY_POINTS),
  'src/cli/index.ts',
  'config/scripts/build-orcad-bun.mjs',
  'config/scripts/build-orcad.mjs',
  'config/scripts/ensure-native-runtime.mjs',
  'config/scripts/rebuild-native-deps.mjs',
  'config/scripts/verify-cli-bin.mjs',
  'config/scripts/install-dev-cli.mjs',
  'config/scripts/orca-dev.mjs',
  'config/scripts/runtime-serve-terminal-smoke.mjs',
  'config/scripts/orcad-terminal-smoke-change-scope.mjs'
]

export function collectOrcadTerminalSmokeInputs() {
  return collectBunProfileInputs({ entryPoints: ENTRY_POINTS })
}

export async function classifyOrcadTerminalSmokeChanges(
  changedFiles,
  collect = collectOrcadTerminalSmokeInputs
) {
  const forced = changedFiles.find(
    (file) =>
      ENTRY_POINTS.includes(file) ||
      file === '.github/workflows/pr.yml' ||
      file.startsWith('config/scripts/orcad-terminal-smoke-') ||
      file.startsWith('config/scripts/runtime-serve-terminal-smoke') ||
      // createRequire-loaded native probes are invisible to esbuild's import graph.
      (file.startsWith('config/scripts/') && file.endsWith('.cjs')) ||
      // CLI emit and runtime resources include files opened by path, outside the import graph.
      file.startsWith('src/cli/') ||
      file.startsWith('src/shared/') ||
      file.startsWith('resources/')
  )
  if (forced) {
    return { shouldRun: true, reason: `Smoke input changed: ${forced}` }
  }
  // Retain the Bun gate's native, worker, toolchain and failed-analysis safeguards.
  return classifyBunProfileChanges(changedFiles, collect)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const changedFiles = readFileSync(process.argv[2], 'utf8').split('\0').filter(Boolean)
  const result = await classifyOrcadTerminalSmokeChanges(changedFiles)
  console.error(result.reason)
  process.stdout.write(`${result.shouldRun}\n`)
}
