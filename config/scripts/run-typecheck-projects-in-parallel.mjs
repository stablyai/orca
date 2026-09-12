import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const tsc = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url))

// The projects overlap but have no build dependency, so they can check concurrently.
const projects = [
  {
    name: 'tsconfig.node.json',
    args: [tsc, '--noEmit', '-p', 'config/tsconfig.node.json']
  },
  {
    name: 'tsconfig.tc.cli.json',
    args: [tsc, '--noEmit', '-p', 'config/tsconfig.tc.cli.json']
  },
  {
    name: 'tsconfig.tc.web.json',
    args: [tsc, '--noEmit', '-p', 'config/tsconfig.tc.web.json']
  },
  {
    name: 'tsconfig.tooling.json',
    args: [tsc, '--noEmit', '-p', 'config/tsconfig.tooling.json']
  },
  {
    name: 'tsconfig.e2e.json',
    args: [
      'config/scripts/typecheck-diagnostic-baseline.mjs',
      '--project',
      'config/tsconfig.e2e.json',
      '--baseline',
      'config/typecheck-e2e-diagnostics.json'
    ]
  }
]

// Keep the original three-process ceiling; each additional project holds a full compiler graph.
const maxConcurrent = Math.min(availableParallelism(), 3)

function checkProject(project) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, project.args, {
      cwd: repoRoot,
      stdio: 'inherit'
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${project.name} exited with signal ${signal}`))
      } else if (code !== 0) {
        reject(new Error(`${project.name} exited with code ${code}`))
      } else {
        resolve()
      }
    })
  })
}

const failures = []
let nextProject = 0
async function runProjectWorker() {
  while (nextProject < projects.length) {
    const project = projects[nextProject]
    nextProject += 1
    try {
      await checkProject(project)
    } catch (error) {
      failures.push(error)
    }
  }
}
await Promise.all(
  Array.from({ length: Math.min(maxConcurrent, projects.length) }, runProjectWorker)
)

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure.message ?? failure)
  }
  process.exit(1)
}
