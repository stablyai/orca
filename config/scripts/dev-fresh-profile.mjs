#!/usr/bin/env node
// Isolate first-run onboarding from persisted dev profiles.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnProcess } from '@orca/process-host'
import { getDefaultSeedSource, seedDevProfile } from './dev-profile-seed.mjs'

const USAGE = `Usage: pnpm dev:fresh [--keep] [--seed-from[=<profile dir>]] [-- <pnpm dev args>]

  --keep                 keep the temporary profile after exit
  --seed-from[=<dir>]    start from a slim copy of a profile (projects, workspaces, settings,
                         SSH targets, account session); default: orca-dev, else the installed app
  ORCA_FRESH_PROFILE_DIR=<dir>   use (and keep) a fixed profile directory`

const TEMP_PREFIX = 'orca-fresh-profile-'

function parseArgs(argv) {
  const options = { keep: false, seedFrom: null, devArgs: [] }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--') {
      options.devArgs = argv.slice(index + 1)
      break
    }
    if (arg === '--keep') {
      options.keep = true
    } else if (arg === '--seed-from') {
      options.seedFrom = getDefaultSeedSource()
    } else if (arg.startsWith('--seed-from=')) {
      options.seedFrom = path.resolve(arg.slice('--seed-from='.length))
    } else if (arg === '-h' || arg === '--help') {
      options.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}\n${USAGE}`)
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  console.log(USAGE)
  process.exit(0)
}

const fixedDir = process.env.ORCA_FRESH_PROFILE_DIR
const profileDir = fixedDir ? path.resolve(fixedDir) : mkdtempSync(path.join(tmpdir(), TEMP_PREFIX))
mkdirSync(profileDir, { recursive: true })

function cleanup() {
  const removable = !options.keep && !fixedDir && path.basename(profileDir).startsWith(TEMP_PREFIX)
  if (removable && existsSync(profileDir)) {
    rmSync(profileDir, { recursive: true, force: true })
    console.error(`[dev-fresh-profile] removed ${profileDir}`)
  } else {
    console.error(`[dev-fresh-profile] kept ${profileDir}`)
  }
}

try {
  if (options.seedFrom) {
    await seedDevProfile({ sourceDir: options.seedFrom, targetDir: profileDir })
  }
} catch (error) {
  console.error(`[dev-fresh-profile] ${error.message}`)
  cleanup()
  process.exit(1)
}

console.error(`[dev-fresh-profile] using userData=${profileDir}`)
const child = spawnProcess({
  program: 'pnpm',
  args: ['dev', ...options.devArgs],
  env: {
    ...process.env,
    ORCA_DEV_USER_DATA_PATH: profileDir,
    // Why: seeded profiles already finished onboarding; only empty ones should show first-run education.
    ...(options.seedFrom ? {} : { ORCA_DEV_SHOW_FIRST_RUN_EDUCATION: '1' })
  },
  stdio: 'inherit'
})
// Why: Ctrl+C reaches pnpm through the shared terminal; wait for it so cleanup sees a closed profile.
process.on('SIGINT', () => {})
process.on('SIGTERM', () => child.kill('SIGTERM'))
child.on('exit', (code, signal) => {
  cleanup()
  process.exit(code ?? (signal ? 1 : 0))
})
child.on('error', (error) => {
  console.error(`[dev-fresh-profile] ${error.message}`)
  cleanup()
  process.exit(1)
})
