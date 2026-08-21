import { spawnSync } from 'node:child_process'

const result = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  [
    'exec',
    'playwright',
    'test',
    'tests/e2e/nested-runtime-ssh-routing.spec.ts',
    'tests/e2e/nested-runtime-ssh-lifecycle.spec.ts',
    '--config',
    'tests/playwright.config.ts',
    '--project',
    'electron-headless',
    '--workers=1'
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ORCA_E2E_NESTED_RUNTIME_SSH: '1',
      ORCA_E2E_SSH_DOCKER: '1',
      ORCA_E2E_WEB_CLIENT: '1'
    },
    stdio: 'inherit'
  }
)

if (result.error) {
  throw result.error
}
process.exit(result.status ?? 1)
