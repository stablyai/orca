import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'

// The three projects overlap heavily in src/shared but have no build dependency on
// each other, so tsc can check them concurrently instead of in a `&&` chain.
const projects = ['tsconfig.node.json', 'tsconfig.tc.cli.json', 'tsconfig.tc.web.json']
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const tsc = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url))

// Why serialize on a single-core runner: three tsc processes there thrash rather than overlap.
const concurrent = availableParallelism() > 1

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

let failures = []
if (concurrent) {
  const results = await Promise.allSettled(projects.map(checkProject))
  failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason)
} else {
  for (const project of projects) {
    try {
      await checkProject(project)
    } catch (error) {
      failures.push(error)
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure.message ?? failure)
  }
  process.exit(1)
}
