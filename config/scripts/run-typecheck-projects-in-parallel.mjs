import { spawn } from 'node:child_process'
import { availableParallelism, totalmem } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

function checkProject(project) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsc, '--noEmit', '-p', `config/${project}`], {
      cwd: repoRoot,
      stdio: 'inherit'
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`tsc ${project} exited with signal ${signal}`))
      } else if (code !== 0) {
        reject(new Error(`tsc ${project} exited with code ${code}`))
      } else {
        resolve()
      }
    })
  })
}

async function runTypecheckProjects() {
  const batches = planTypecheckBatches(TYPECHECK_PROJECTS, {
    budgetGib: admissibleHeapGib(totalmem()),
    parallelism: availableParallelism()
  })

  // Every batch runs even after one fails, so a single broken project still reports the rest.
  const failures = []
  for (const batch of batches) {
    const results = await Promise.allSettled(batch.map((project) => checkProject(project.config)))
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
