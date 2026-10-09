import { availableParallelism, totalmem } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnProcess } from './script-child-process.mjs'

const BYTES_PER_GIB = 1024 ** 3

// Peak heap per project, read from `tsc --extendedDiagnostics` and rounded up. node and
// web are the expensive pair: run together they exceed a 16 GB CI runner, and an
// out-of-memory runner is killed mid-check, so the job reports a lost runner instead of a
// type error. Admission is therefore by memory, not by core count alone.
export const TYPECHECK_PROJECTS = [
  { config: 'tsconfig.node.json', heapGib: 7 },
  { config: 'tsconfig.tc.web.json', heapGib: 6 },
  { config: 'tsconfig.tc.cli.json', heapGib: 2 }
]

// The OS, node itself, and the runner agent need their share; the rest is what tsc may hold.
export function admissibleHeapGib(totalBytes) {
  return Math.max(1, (totalBytes / BYTES_PER_GIB) * 0.75)
}

/**
 * Heaviest first, admitting another project only while it fits both the memory budget and
 * the core count. A project larger than the whole budget still runs, alone, so a small
 * machine makes progress rather than producing an empty batch forever.
 */
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
const tsc = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url))

export function typecheckInvocation(project, bunPath = process.env.ORCA_TYPECHECK_BUN) {
  const config = `config/${project}`
  return bunPath
    ? {
        program: bunPath,
        args: ['check', '-p', config, '--threads', String(availableParallelism())]
      }
    : { program: process.execPath, args: [tsc, '--noEmit', '-p', config] }
}

export function checkProject(project, startCompiler = spawnProcess) {
  return new Promise((resolve, reject) => {
    const child = startCompiler({
      ...typecheckInvocation(project),
      cwd: repoRoot,
      env: process.env
    })
    let streamFailure
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      // Keep the batch occupied until close even when a compiler pipe fails.
      stream.on('error', (error) => {
        streamFailure ??= error
      })
    }
    child.stdout.pipe(process.stdout)
    child.stderr.pipe(process.stderr)
    child.stdin.end()

    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (streamFailure) {
        reject(streamFailure)
      } else if (signal) {
        reject(new Error(`typecheck ${project} exited with signal ${signal}`))
      } else if (code !== 0) {
        reject(new Error(`typecheck ${project} exited with code ${code}`))
      } else {
        resolve()
      }
    })
  })
}

export async function runTypecheckProjects(check = checkProject) {
  const batches = planTypecheckBatches(TYPECHECK_PROJECTS, {
    budgetGib: admissibleHeapGib(totalmem()),
    parallelism: availableParallelism()
  })

  // Every batch runs even after one fails, so a single broken project still reports the rest.
  const failures = []
  for (const batch of batches) {
    const results = await Promise.allSettled(batch.map((project) => check(project.config)))
    for (const result of results) {
      if (result.status === 'rejected') {
        failures.push(result.reason)
      }
    }
  }

  return failures
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = await runTypecheckProjects()
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure.message ?? failure)
    }
    process.exit(1)
  }
}
