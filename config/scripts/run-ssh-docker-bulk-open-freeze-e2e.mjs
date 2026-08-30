import { spawnSync } from 'node:child_process'

const extraArgs = process.argv.slice(2)
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const env = {
  ...process.env,
  ORCA_E2E_SSH_DOCKER: '1'
}
const spawnOptions = {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32'
}

const runtime = spawnSync(pnpm, ['run', 'ensure:electron-runtime'], spawnOptions)

if (runtime.status !== 0) {
  process.exit(runtime.status ?? 1)
}

const result = spawnSync(
  pnpm,
  [
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
  spawnOptions
)

process.exit(result.status ?? 1)
