import { spawnSync } from 'node:child_process'

const rawExtraArgs = process.argv.slice(2)
const extraArgs = rawExtraArgs[0] === '--' ? rawExtraArgs.slice(1) : rawExtraArgs
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const env = {
  ...process.env,
  ORCA_E2E_SSH_DOCKER: '1',
  ORCA_E2E_WEB_CLIENT: '1'
}

// Why: Node's CVE-2024-27980 hardening rejects .cmd spawns without shell on Windows.
const spawnOptions = {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32'
}

const runtime = spawnSync(pnpm, ['run', 'ensure:electron-runtime'], spawnOptions)

if (runtime.status !== 0) {
  process.exit(runtime.status ?? 1)
}

// Why one runner: these specs share the Docker SSH rig; startup-exec also joins
// the paired desktop/headless parity proof under the same isolated CI lane.
const result = spawnSync(
  pnpm,
  [
    'exec',
    'playwright',
    'test',
    'tests/e2e/ssh-terminal-parking.spec.ts',
    'tests/e2e/terminal-retention-budget.spec.ts',
    'tests/e2e/ssh-startup-exec-readiness.spec.ts',
    'tests/e2e/paired-startup-exec-readiness.spec.ts',
    '--config',
    'tests/playwright.config.ts',
    '--project',
    'electron-headless',
    '--project',
    'electron-headful',
    '--workers=1',
    ...extraArgs
  ],
  spawnOptions
)

process.exit(result.status ?? 1)
