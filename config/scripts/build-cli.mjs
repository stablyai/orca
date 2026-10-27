import { availableParallelism } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
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
  compiler = process.env.ORCA_CLI_BUILD_COMPILER ?? 'bun',
  resolveBunExecutable = (directory) => resolvePinnedBunExecutable(directory, runProcessSync)
} = {}) {
  if (compiler !== 'bun' && compiler !== 'tsrs') {
    throw new Error(`Invalid ORCA_CLI_BUILD_COMPILER: ${compiler}`)
  }
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
  if (compiler === 'tsrs') {
    const manifest = createRequire(join(root, 'package.json')).resolve('tsrs/package.json')
    const result = await execute({
      program: process.execPath,
      args: [join(dirname(manifest), 'bin', 'tsrs'), ...emitArguments, '--noEmitOnError'],
      cwd: root,
      stdio: 'inherit',
      timeoutMs: null
    })
    if (result.code !== 0) {
      throw new Error(`CLI compilation failed: ${describeProcessFailure(result)}`)
    }
    return
  }
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
