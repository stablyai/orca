import { runProcessSync } from '@orca/process-host'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePinnedBunExecutable } from '../../config/scripts/pinned-bun-executable.mjs'
import {
  resolveTypecheckCommand,
  selectTypecheckCompiler
} from '../../config/scripts/run-typecheck-projects-in-parallel.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))

// Run from the mobile cwd for relative diagnostics; ORCA_MOBILE_TYPECHECK_COMPILER selects auto|tsrs|bun|native.
export function resolveMobileTypecheckCommand(project, cwd = process.cwd()) {
  const requested = process.env.ORCA_MOBILE_TYPECHECK_COMPILER ?? 'auto'
  if (!/^(auto|tsrs|bun|native)$/.test(requested)) {
    throw new Error(`Unknown mobile typecheck compiler: ${requested}`)
  }
  const selection = selectTypecheckCompiler(requested, {
    root,
    resolveBunExecutable: (repoRoot) => resolvePinnedBunExecutable(repoRoot, runProcessSync)
  })
  const command = resolveTypecheckCommand(resolve(cwd, project), {
    ...selection,
    bunThreads: 2,
    root
  })
  return { ...command, cwd, compiler: selection.compiler }
}
