import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'
import { runProcess, runProcessSync } from '@orca/process-host'
import { resolvePinnedBunExecutable } from './pinned-bun-executable.mjs'
import { describeProcessFailure } from './process-failure-message.mjs'
import { isDirectInvocation } from './script-entry-detection.mjs'
import { resolveTsrsCompiler } from './tsrs-typecheck-compiler.mjs'
import { runIncrementalCliBuild } from './cli-build-state.mjs'
import {
  resolveProjectCompiler,
  runTypecheckProjects,
  selectTypecheckCompiler
} from './run-typecheck-projects-in-parallel.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CONFIG = 'config/tsconfig.build.cli.json'

export async function buildCli({
  root = ROOT,
  outDir = 'out',
  check = runTypecheckProjects,
  execute = runProcess,
  compiler = process.env.ORCA_CLI_BUILD_COMPILER ?? (process.env.CI ? 'bun' : 'auto'),
  resolveBunExecutable = (directory) => resolvePinnedBunExecutable(directory, runProcessSync)
} = {}) {
  if (!['auto', 'bun', 'tsrs'].includes(compiler)) {
    throw new Error(`Invalid ORCA_CLI_BUILD_COMPILER: ${compiler}`)
  }
  const selection = selectTypecheckCompiler(compiler, { root, resolveBunExecutable })
  const emitArguments = [
    '-p',
    CONFIG,
    '--outDir',
    outDir,
    '--composite',
    'false',
    '--incremental',
    'false'
  ]
  if (selection.compiler === 'tsrs') {
    return runIncrementalCliBuild({
      root,
      outDir,
      config: CONFIG,
      compiler: resolveTsrsCompiler(root),
      emitter: { program: process.execPath, args: [resolveProjectCompiler(CONFIG, root)] },
      execute
    })
  }
  const failures = await check({
    ...selection,
    root,
    projects: [{ config: CONFIG, heapGib: 2 }],
    bunThreads: availableParallelism()
  })
  if (failures.length > 0) {
    throw failures[0]
  }

  // Bun has checked this exact project; retain TypeScript's emitter without checking it twice.
  const result = await execute({
    program: process.execPath,
    args: [resolveProjectCompiler(CONFIG, root), ...emitArguments, '--noCheck'],
    cwd: root,
    stdio: 'inherit',
    timeoutMs: null
  })
  if (result.code !== 0) {
    throw new Error(`CLI emission failed: ${describeProcessFailure(result)}`)
  }
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  try {
    await buildCli()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
