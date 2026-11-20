// Command-line options for the fleet gate, validated before anything is built.
import path from 'node:path'
import { SCENARIOS } from './fleet-gate-scenarios.mjs'

// Packaged builds don't expose the store the gate seeds, drives and probes through.
function packagedAppUnsupported() {
  throw new Error(
    'packaged apps are not supported: pass the release tags (--old v1.4.262 --new <candidate>); the gate rebuilds them from source in e2e mode'
  )
}

export function parseArgs(argv) {
  const options = {
    old: null,
    new: 'HEAD',
    seed: process.env.ORCA_FLEET_SEED_DIR ?? null,
    runs: 2,
    settleMs: 120_000,
    windowMs: 30_000,
    idleWindowMs: 60_000,
    scenarios: null,
    force: false,
    pathsOnly: false,
    out: null
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      index += 1
      // A following option is a missing value, not the value (`./--x` still names a path).
      if (argv[index] === undefined || argv[index].startsWith('--')) {
        throw new Error(`${arg} needs a value`)
      }
      return argv[index]
    }
    const setters = {
      '--old': () => (options.old = value()),
      '--new': () => (options.new = value()),
      '--seed': () => (options.seed = path.resolve(value())),
      '--runs': () => (options.runs = Number(value())),
      '--settle-ms': () => (options.settleMs = Number(value())),
      '--window-ms': () => (options.windowMs = Number(value())),
      '--idle-window-ms': () => (options.idleWindowMs = Number(value())),
      '--scenarios': () => (options.scenarios = value().split(',').filter(Boolean)),
      '--out': () => (options.out = path.resolve(value())),
      '--force': () => (options.force = true),
      '--paths-only': () => (options.pathsOnly = true),
      '--old-app': packagedAppUnsupported,
      '--new-app': packagedAppUnsupported,
      '--': () => {}
    }
    if (!Object.hasOwn(setters, arg)) {
      throw new Error(`unknown argument ${arg}`)
    }
    setters[arg]()
  }
  for (const [flag, ms] of [
    ['--settle-ms', options.settleMs],
    ['--window-ms', options.windowMs],
    ['--idle-window-ms', options.idleWindowMs]
  ]) {
    if (!Number.isFinite(ms) || ms < 1_000 || ms > 3_600_000) {
      throw new Error(`${flag} must be between 1000 and 3600000 ms`)
    }
  }
  if (!Number.isInteger(options.runs) || options.runs < 2 || options.runs % 2 !== 0) {
    throw new Error('--runs must be an even number of at least 2')
  }
  if (options.scenarios?.length === 0) {
    throw new Error('--scenarios names no scenario')
  }
  for (const name of options.scenarios ?? []) {
    if (!Object.hasOwn(SCENARIOS, name) && name !== 'burst') {
      throw new Error(
        `unknown scenario ${String(name)}; known: ${Object.keys(SCENARIOS).join(', ')}`
      )
    }
  }
  return options
}
