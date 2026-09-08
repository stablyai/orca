import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { resolvePnpmCliInvocation } from './pnpm-cli-invocation.mjs'

if (process.platform !== 'darwin') {
  throw new Error('Hosted iOS WebView automation requires macOS and Xcode.')
}

const { command: pnpm, prefixArgs: pnpmPrefix, shell } = resolvePnpmCliInvocation()
const env = { ...process.env, ORCA_E2E_SSH_DOCKER: '1' }
const prebuildCommands =
  process.env.SKIP_BUILD === '1'
    ? []
    : [
        ['run', 'build:cli'],
        ['run', 'build:mobile-web-rnw']
      ]
const commands = [
  ...prebuildCommands,
  ['run', 'ensure:electron-runtime'],
  [
    'exec',
    'playwright',
    'test',
    'tests/e2e/hosted-mobile-webview-ssh.spec.ts',
    '--config',
    'tests/playwright.config.ts',
    '--project',
    'electron-headless',
    '--workers=1',
    ...process.argv.slice(2)
  ]
]

for (const args of commands) {
  const result = spawnSync(pnpm, [...pnpmPrefix, ...args], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
    shell
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
