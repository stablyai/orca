import { spawnSync } from 'node:child_process'
import { resolvePnpmCliInvocation } from './pnpm-cli-invocation.mjs'

const extraArgs = process.argv.slice(2)
const { command: pnpm, prefixArgs: pnpmPrefix, shell } = resolvePnpmCliInvocation()
const env = {
  ...process.env,
  ORCA_E2E_SSH_DOCKER: '1'
}

const runtime = spawnSync(pnpm, [...pnpmPrefix, 'run', 'ensure:electron-runtime'], {
  stdio: 'inherit',
  env,
  shell
})

if (runtime.status !== 0) {
  process.exit(runtime.status ?? 1)
}

const result = spawnSync(
  pnpm,
  [
    ...pnpmPrefix,
    'exec',
    'playwright',
    'test',
    'tests/e2e/ssh-docker-bulk-open-freeze-repro.spec.ts',
    '--config',
    'tests/playwright.config.ts',
    '--project',
    'electron-headless',
    '--workers=1',
    ...extraArgs
  ],
  {
    stdio: 'inherit',
    env,
    shell
  }
)

process.exit(result.status ?? 1)
