import path from 'node:path'

const DESKTOP_BUILD_TIMEOUT_MS = 300_000

export async function prepareEmulatorDesktopRuntime({
  worktree,
  cliOverride,
  runCommand,
  logStep,
  logSuccess
}) {
  const explicitCli = cliOverride?.trim()
  if (explicitCli) {
    return explicitCli
  }

  logStep('0', 'Building current desktop runtime for mobile pairing...')
  await runCommand('pnpm', ['run', 'build:cli'], {
    cwd: worktree,
    timeout: DESKTOP_BUILD_TIMEOUT_MS
  })
  await runCommand('pnpm', ['run', 'build:electron-vite'], {
    cwd: worktree,
    timeout: DESKTOP_BUILD_TIMEOUT_MS
  })
  logSuccess('Current desktop runtime built')

  // Why: pairing against an installed app can silently mix incompatible
  // mobile and desktop protocol/transcript behavior.
  return path.join(worktree, 'config', 'scripts', 'orca-dev.mjs')
}
