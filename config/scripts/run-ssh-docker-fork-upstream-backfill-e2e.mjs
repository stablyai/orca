import { spawnSync } from 'node:child_process'
import { resolvePnpmCliSpawn } from './pnpm-cli-spawn.mjs'

const rawExtraArgs = process.argv.slice(2)
const extraArgs = rawExtraArgs[0] === '--' ? rawExtraArgs.slice(1) : rawExtraArgs
const env = {
  ...process.env,
  ORCA_E2E_SSH_DOCKER: '1'
}

const spawnOptions = {
  stdio: 'inherit',
  env
}

function runPnpm(args) {
  const invocation = resolvePnpmCliSpawn(args)
  return spawnSync(invocation.command, invocation.args, spawnOptions)
}

const runtime = runPnpm(['run', 'ensure:electron-runtime'])

if (runtime.status !== 0) {
  process.exit(runtime.status ?? 1)
}

const result = runPnpm([
  'exec',
  'playwright',
  'test',
  'tests/e2e/ssh-docker-fork-upstream-backfill.spec.ts',
  '--config',
  'tests/playwright.config.ts',
  '--project',
  'electron-headless',
  '--workers=1',
  ...extraArgs
])

process.exit(result.status ?? 1)
