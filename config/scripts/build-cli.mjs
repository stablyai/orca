import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'
import { runProcess, runProcessSync } from '@orca/process-host'
import { resolvePinnedBunExecutable } from './pinned-bun-executable.mjs'
import { describeProcessFailure } from './process-failure-message.mjs'
import { isDirectInvocation } from './script-entry-detection.mjs'
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
  resolveBunExecutable = (directory) => resolvePinnedBunExecutable(directory, runProcessSync)
} = {}) {
  const selection = selectTypecheckCompiler('bun', { root, resolveBunExecutable })
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
    args: [
      resolveProjectCompiler(CONFIG, root),
      '-p',
      CONFIG,
      '--outDir',
      outDir,
      '--composite',
      'false',
      '--incremental',
      'false',
      '--noCheck'
    ],
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
