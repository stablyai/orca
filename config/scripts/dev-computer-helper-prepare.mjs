import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Prepares the optional macOS Computer Use helper for local development.
 * Missing helpers are advisory unless the caller explicitly opts into a build.
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

  const helperPath = path.join(
    repoRoot,
    'native',
    'computer-use-macos',
    '.build',
    'release',
    'Orca Computer Use.app'
  )
  if (existsSync(helperPath)) {
    return
  }

  if (env.ORCA_DEV_COMPUTER_PREPARE !== '1') {
    writeMessage(
      '[orca-dev] Computer Use helper missing; desktop development will continue without it. Run `pnpm run build:computer-macos` or set ORCA_DEV_COMPUTER_PREPARE=1 to build it automatically.'
    )
    return
  }

  writeMessage('[orca-dev] Building Computer Use helper...')
  runBuild()
}
