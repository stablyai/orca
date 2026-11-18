import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Perf runs too heavy for CI (real app builds, minutes of Electron): people start them by hand, CI never does.
export const MANUAL_ONLY_RUNS = [
  {
    name: 'fleet perf gate',
    scripts: ['perf:fleet-gate'],
    paths: ['config/scripts/performance/fleet-gate', 'run-fleet-gate']
  },
  {
    name: 'idle CPU benchmark',
    scripts: ['bench:idle-cpu'],
    paths: ['config/scripts/performance/idle-cpu/run-idle-cpu-benchmark', 'run-idle-cpu-benchmark']
  }
]

const CI_DIRS = ['.github/workflows', '.github/actions', '.github/scripts']
const SELF = '.github/scripts/check-manual-only-perf-runs.mjs'

function filesUnder(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.posix.join(dir, entry)
    return statSync(full).isDirectory() ? filesUnder(full) : [full]
  })
}

// Whole script names only, so `bench:idle-cpu-foo` doesn't count as `bench:idle-cpu`.
function mentionsScript(text, script) {
  const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\w:-])${escaped}(?![\\w:-])`).test(text)
}

function mentions(text, run) {
  return (
    run.scripts.some((script) => mentionsScript(text, script)) ||
    run.paths.some((p) => text.includes(p))
  )
}

export function findCiReferences(root = '.') {
  const failures = []
  for (const dir of CI_DIRS) {
    for (const file of filesUnder(path.posix.join(root, dir))) {
      const relative = path.posix.relative(root, file)
      if (relative === SELF) {
        continue
      }
      const text = readFileSync(file, 'utf8')
      for (const run of MANUAL_ONLY_RUNS.filter((r) => mentions(text, r))) {
        failures.push(`${relative} references the ${run.name}`)
      }
    }
  }
  // CI runs package scripts (lint, test, check:*), so no script other than the run's own entry may chain into it.
  const { scripts = {} } = JSON.parse(readFileSync(path.posix.join(root, 'package.json'), 'utf8'))
  for (const [name, command] of Object.entries(scripts)) {
    for (const run of MANUAL_ONLY_RUNS) {
      if (!run.scripts.includes(name) && mentions(command, run)) {
        failures.push(`package.json script "${name}" invokes the ${run.name}`)
      }
    }
  }
  return failures
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = findCiReferences()
  if (failures.length > 0) {
    console.error(
      `These perf runs are manual only and must never run in CI:\n${failures.join('\n')}\n` +
        `Start them by hand instead (see docs/readme/fleet-perf-gate.md).`
    )
    process.exit(1)
  }
  console.log('No CI path starts a manual-only perf run.')
}
