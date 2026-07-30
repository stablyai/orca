import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Checks the runtime-selected macOS Computer Use helper during development.
 * Missing worktree helpers are advisory unless ORCA_DEV_COMPUTER_PREPARE=1;
 * incomplete explicit overrides remain advisory because rebuilding the
 * worktree helper cannot repair an override owned by the caller.
 *
 * The injected build callback runs synchronously only for an opted-in missing
 * or incomplete worktree helper, and its failures propagate to stop startup.
 */
export function prepareDevComputerHelper(options) {
  const {
    env,
    isHelpOrVersion,
    platform,
    repoRoot,
    runBuild,
    writeMessage = (message) => console.error(message)
  } = options
  if (platform !== 'darwin' || isHelpOrVersion || env.ORCA_SKIP_DEV_COMPUTER_PREPARE === '1') {
    return
  }

  const worktreeHelperPath = path.join(
    repoRoot,
    'native',
    'computer-use-macos',
    '.build',
    'release',
    'Orca Computer Use.app'
  )
  // Why: runtime resolution prefers an existing override even when its bundle
  // is incomplete, so preflight must inspect that same candidate first.
  const overridePath = env.ORCA_COMPUTER_MACOS_HELPER_APP_PATH
  const usesOverride = Boolean(overridePath && existsSync(overridePath))
  const helperPath = usesOverride ? overridePath : worktreeHelperPath
  const executablePath = path.join(helperPath, 'Contents', 'MacOS', 'orca-computer-use-macos')
  if (existsSync(executablePath)) {
    return
  }

  if (usesOverride) {
    writeMessage(
      `[orca-dev] Computer Use helper override is incomplete at ${JSON.stringify(helperPath)}. Fix or unset ORCA_COMPUTER_MACOS_HELPER_APP_PATH; desktop development will continue without Computer Use.`
    )
    return
  }

  if (env.ORCA_DEV_COMPUTER_PREPARE !== '1') {
    writeMessage(
      '[orca-dev] Computer Use helper missing or incomplete; desktop development will continue without it. Run `pnpm run build:computer-macos` or set ORCA_DEV_COMPUTER_PREPARE=1 to build it automatically.'
    )
    return
  }

  writeMessage('[orca-dev] Building Computer Use helper...')
  runBuild()
}
