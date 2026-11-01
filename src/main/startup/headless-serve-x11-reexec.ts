import { app } from 'electron'
import {
  HEADLESS_SERVE_OZONE_PLATFORM_SWITCH,
  hasExplicitOzonePlatform
} from '../../shared/headless-serve-ozone-platform'

export type HeadlessServeX11ReexecOptions = {
  isServeMode: boolean
  /** The platform Electron already resolved into `--ozone-platform`; read only for Linux serve. */
  readResolvedOzonePlatform?: () => string
  argv?: string[]
  platform?: NodeJS.Platform
  execPath?: string
  env?: NodeJS.ProcessEnv
  /** Replaces this process; null when the runtime cannot. */
  execve: ((file: string, args: string[], env: NodeJS.ProcessEnv) => void) | null
}

/** Pin direct Wayland serve launches to X11 via exec, preserving PID for systemd/AppImage ownership. Continue in-process if exec is unavailable/fails. */
export function reexecHeadlessServeOnX11IfNeeded(options: HeadlessServeX11ReexecOptions): void {
  const argv = options.argv ?? process.argv
  if (
    !options.isServeMode ||
    (options.platform ?? process.platform) !== 'linux' ||
    // The explicit switch also fences exec recursion.
    hasExplicitOzonePlatform(argv.slice(1)) ||
    !options.execve ||
    readOzonePlatform(options).trim().toLowerCase() !== 'wayland'
  ) {
    return
  }
  const execPath = options.execPath ?? process.execPath
  try {
    // Place before any -- terminator so Chromium reads a switch rather than a positional.
    options.execve(
      execPath,
      [execPath, HEADLESS_SERVE_OZONE_PLATFORM_SWITCH, ...argv.slice(1)],
      options.env ?? process.env
    )
  } catch (error) {
    process.stderr.write(
      `[serve] Could not restart on X11: ${error instanceof Error ? error.message : String(error)}\n`
    )
  }
}

function readOzonePlatform(options: HeadlessServeX11ReexecOptions): string {
  return options.readResolvedOzonePlatform
    ? options.readResolvedOzonePlatform()
    : app.commandLine.getSwitchValue('ozone-platform')
}
