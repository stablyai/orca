/**
 * `orca serve`'s app-side question, run by the CLI with the app's own executable under
 * ELECTRON_RUN_AS_NODE: prepare this machine's orcad slot if it can serve, and print one
 * `ORCA_SERVE_RUNTIME` line saying which host to run. Diagnostics go to stderr.
 */
import { join } from 'node:path'
import process from 'node:process'
import {
  formatServeRuntimeSelection,
  ORCAD_LOCAL_SERVE_SELECTION_FLAGS as FLAGS
} from '../../shared/orcad-local-serve-selection'
import { selectServeRuntime } from './orcad-local-serve-selection'
import { pruneDesktopOrcadArtifactCache } from './orcad-artifact-cache-retention'

function flagValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag)
  return index === -1 ? null : (argv[index + 1] ?? null)
}

async function run(argv: readonly string[]): Promise<void> {
  const userDataPath = flagValue(argv, FLAGS.userData)
  const appRoot = flagValue(argv, FLAGS.appRoot)
  if (!userDataPath || !appRoot) {
    throw new Error(`${FLAGS.userData} and ${FLAGS.appRoot} are required`)
  }
  const selection = await selectServeRuntime({
    env: process.env,
    platform: process.platform,
    userDataPath,
    templateDirs: [
      ...(process.resourcesPath ? [join(process.resourcesPath, 'orcad-template')] : []),
      join(appRoot, 'out', 'orcad-template')
    ]
  })
  // orcad serve never starts the desktop's startup pass, so the slot cache is bounded here too.
  await pruneDesktopOrcadArtifactCache(
    userDataPath,
    selection.kind === 'orcad' ? [selection.version] : []
  ).catch(() => [])
  process.stdout.write(`${formatServeRuntimeSelection(selection)}\n`, () => process.exit(0))
}

run(process.argv.slice(2)).catch((error: unknown) => {
  // Any failure here is a reason to serve on Electron, never to fail `orca serve`.
  const reason = `orcad selection failed: ${error instanceof Error ? error.message : String(error)}`
  process.stdout.write(`${formatServeRuntimeSelection({ kind: 'electron', reason })}\n`, () =>
    process.exit(0)
  )
})
