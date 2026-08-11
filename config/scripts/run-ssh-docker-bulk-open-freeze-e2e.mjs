import { spawnSync } from 'node:child_process'

const extraArgs = process.argv.slice(2)
const pnpmEntry = process.env.npm_execpath
if (!pnpmEntry) {
  throw new Error('npm_execpath is required; run this harness through pnpm')
}
const env = {
  ...process.env,
  ORCA_E2E_SSH_DOCKER: '1'
}

const runtime = spawnSync(process.execPath, [pnpmEntry, 'run', 'ensure:electron-runtime'], {
  stdio: 'inherit',
  env
})

if (runtime.status !== 0) {
  process.exit(runtime.status ?? 1)
}

const result = spawnSync(
  process.execPath,
  [
    pnpmEntry,
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
    env
  }
)

process.exit(result.status ?? 1)
