import { runProcessSync, spawnProcess } from '@orca/process-host'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { availableParallelism, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readPinnedBunVersion, resolvePinnedBunExecutable } from './pinned-bun-executable.mjs'
import { resolveTsrsTypecheckCommand, supportsTsrs } from './tsrs-typecheck-compiler.mjs'

const BYTES_PER_GIB = 1024 ** 3

// Admit by measured peak tsc heap, not cores alone: node+web exceed 16GB runners and OOM looks like lost runner rather than type error.
export const TYPECHECK_PROJECTS = [
  { config: 'config/tsconfig.node.json', heapGib: 7 },
  { config: 'config/tsconfig.tc.web.json', heapGib: 6 },
  { config: 'config/tsconfig.tc.cli.json', heapGib: 2 },
  // Root projects exclude workspace package tests; each runs with its package's compiler.
  { config: 'src/packages/process-host/tsconfig.test.json', heapGib: 1 }
]

// Selected only by --project: mobile is a separate install that root checks cannot assume.
export const MOBILE_TYPECHECK_PROJECTS = [
  { config: 'mobile/tsconfig.json', heapGib: 2 },
  { config: 'mobile/tsconfig.test.json', heapGib: 3 }
]

// The OS, node itself, and the runner agent need their share; the rest is what tsc may hold.
export function admissibleHeapGib(totalBytes) {
  return Math.max(1, (totalBytes / BYTES_PER_GIB) * 0.75)
}

// Schedule heaviest first within core/memory budgets; oversized project runs alone so small hosts still progress.
export function planTypecheckBatches(projects, { budgetGib, parallelism }) {
  const pending = [...projects].sort((left, right) => right.heapGib - left.heapGib)
  const batches = []

  while (pending.length > 0) {
    const batch = []
    let claimed = 0

    for (let index = 0; index < pending.length;) {
      const project = pending[index]
      const admit =
        batch.length === 0 || (batch.length < parallelism && claimed + project.heapGib <= budgetGib)

      if (admit) {
        batch.push(project)
        claimed += project.heapGib
        pending.splice(index, 1)
      } else {
        index += 1
      }
    }

    batches.push(batch)
  }

  return batches
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

export function resolveProjectCompilerInfo(config, root = repoRoot) {
  const require = createRequire(join(resolve(root, dirname(config)), 'package.json'))
  const manifestPath = require.resolve('typescript/package.json')
  const { bin, version } = JSON.parse(readFileSync(manifestPath, 'utf8'))
  return { program: join(dirname(manifestPath), typeof bin === 'string' ? bin : bin.tsc), version }
}

export function resolveProjectCompiler(config, root = repoRoot) {
  return resolveProjectCompilerInfo(config, root).program
}

// Bun 1.4.3 targets TypeScript 7.0.2; compiler upgrades require a new parity comparison.
export const BUN_TYPESCRIPT_VERSION = '7.0.2'

export function parseTypecheckOptions(args) {
  const options = {
    compiler: 'auto',
    bunConcurrency: 2,
    bunThreads: 4,
    projects: TYPECHECK_PROJECTS
  }
  const selected = []
  for (const argument of args) {
    if (/^--compiler=(auto|tsrs|bun|native)$/.test(argument)) {
      options.compiler = argument.slice('--compiler='.length)
    } else if (argument.startsWith('--bun-concurrency=')) {
      options.bunConcurrency = Number(argument.slice('--bun-concurrency='.length))
    } else if (argument.startsWith('--bun-threads=')) {
      options.bunThreads = Number(argument.slice('--bun-threads='.length))
    } else if (argument.startsWith('--project=')) {
      const config = argument.slice('--project='.length)
      const project = [...TYPECHECK_PROJECTS, ...MOBILE_TYPECHECK_PROJECTS].find(
        (candidate) => candidate.config === config
      )
      if (!project) {
        throw new Error(`Unknown typecheck project: ${config}`)
      }
      selected.push(project)
    } else {
      throw new Error(`Unknown typecheck option: ${argument}`)
    }
  }
  for (const value of [options.bunConcurrency, options.bunThreads]) {
    if (!Number.isInteger(value) || value < 1 || value > 4) {
      throw new Error('Bun concurrency and threads must be integers from 1 to 4')
    }
  }
  if (selected.length > 0) {
    options.projects = selected
  }
  return options
}

export function selectTypecheckCompiler(
  compiler,
  { root, resolveBunExecutable, platform = process.platform, arch = process.arch }
) {
  if (compiler === 'auto') {
    compiler = supportsTsrs(platform, arch) ? 'tsrs' : 'bun'
  }
  if (compiler === 'tsrs' && !supportsTsrs(platform, arch)) {
    throw new Error(`tsrs is unavailable on ${platform}/${arch}; use --compiler=bun.`)
  }
  if (compiler === 'native' || compiler === 'tsrs') {
    return { compiler }
  }
  const bunExecutable = resolveBunExecutable(root)
  if (!bunExecutable) {
    throw new Error(
      `Bun ${readPinnedBunVersion(root)} from devDependencies is missing; run pnpm install, or pass --compiler=native.`
    )
  }
  return { compiler, bunExecutable }
}

export function typecheckBatches(projects, { compiler, bunConcurrency, memoryBytes, parallelism }) {
  return planTypecheckBatches(
    compiler === 'native'
      ? projects
      : projects.map((project) => ({ ...project, heapGib: compiler === 'tsrs' ? 7 : 4 })),
    {
      budgetGib: admissibleHeapGib(memoryBytes),
      parallelism:
        compiler === 'bun'
          ? Math.min(parallelism, bunConcurrency)
          : compiler === 'tsrs'
            ? Math.min(parallelism, 2)
            : parallelism
    }
  )
}

export function resolveTypecheckCommand(config, { compiler, bunExecutable, bunThreads, root }) {
  if (compiler === 'tsrs') {
    return resolveTsrsTypecheckCommand(config, root)
  }
  const installedCompiler = resolveProjectCompilerInfo(config, root)
  if (compiler === 'bun' && installedCompiler.version !== BUN_TYPESCRIPT_VERSION) {
    throw new Error(
      `Bun CI compiler targets TypeScript ${BUN_TYPESCRIPT_VERSION}, but ${config} resolves ${installedCompiler.version}`
    )
  }
  return {
    program: compiler === 'bun' ? bunExecutable : process.execPath,
    args:
      compiler === 'bun'
        ? ['check', '-p', config, '--threads', String(bunThreads), '--no-pretty', '--all']
        : [installedCompiler.program, '--noEmit', '-p', config],
    cwd: root
  }
}

function checkProject(config, { compiler, bunExecutable, bunThreads, root, spawnCompiler }) {
  return new Promise((resolve, reject) => {
    const child = spawnCompiler({
      ...resolveTypecheckCommand(config, { compiler, bunExecutable, bunThreads, root }),
      stdio: 'inherit'
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (signal) {
        reject(new Error(`${compiler} ${config} exited with signal ${signal}`))
      } else if (code !== 0) {
        reject(new Error(`${compiler} ${config} exited with code ${code}`))
      } else {
        resolve()
      }
    })
  })
}

export async function runTypecheckProjects({
  compiler = 'native',
  bunExecutable = 'bun',
  bunConcurrency = 1,
  bunThreads = 4,
  root = repoRoot,
  projects = TYPECHECK_PROJECTS,
  spawnCompiler = spawnProcess,
  memoryBytes = totalmem(),
  parallelism = availableParallelism()
} = {}) {
  const batches = typecheckBatches(projects, { compiler, bunConcurrency, memoryBytes, parallelism })
  if (compiler === 'bun' || compiler === 'tsrs') {
    // Keep a freed compiler slot busy while its peer finishes.
    const pending = batches.flat()
    const failures = []
    let next = 0
    await Promise.all(
      Array.from({ length: Math.max(0, ...batches.map((batch) => batch.length)) }, async () => {
        while (next < pending.length) {
          const index = next++
          try {
            await checkProject(pending[index].config, {
              compiler,
              bunExecutable,
              bunThreads,
              root,
              spawnCompiler
            })
          } catch (reason) {
            failures.push({ index, reason })
          }
        }
      })
    )
    return failures.sort((left, right) => left.index - right.index).map(({ reason }) => reason)
  }
  // Every batch runs even after one fails, so a single broken project still reports the rest.
  const failures = []
  for (const batch of batches) {
    const results = await Promise.allSettled(
      batch.map((project) =>
        checkProject(project.config, { compiler, bunExecutable, bunThreads, root, spawnCompiler })
      )
    )
    for (const result of results) {
      if (result.status === 'rejected') {
        failures.push(result.reason)
      }
    }
  }
  return failures
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseTypecheckOptions(process.argv.slice(2))
  const selection = selectTypecheckCompiler(options.compiler, {
    root: repoRoot,
    resolveBunExecutable: (root) => resolvePinnedBunExecutable(root, runProcessSync)
  })
  const failures = await runTypecheckProjects({ ...options, ...selection })
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure.message ?? failure)
    }
    process.exit(1)
  }
}
