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

/**
 * A direct `--serve` launch (no CLI to add the switch) that Chromium already put on Wayland is
 * exec'd again with X11 pinned. Exec keeps the pid, so systemd and the AppImage runtime still own
 * it. Returns only when no exec was needed or it failed; serve then continues as before.
 */
export function reexecHeadlessServeOnX11IfNeeded(options: HeadlessServeX11ReexecOptions): void {
  const argv = options.argv ?? process.argv
  if (
    !options.isServeMode ||
    (options.platform ?? process.platform) !== 'linux' ||
    // Also the loop fence: the exec'd argv carries the switch.
    hasExplicitOzonePlatform(argv.slice(1)) ||
    !options.execve ||
    readOzonePlatform(options).trim().toLowerCase() !== 'wayland'
  ) {
    return
  }
  const execPath = options.execPath ?? process.execPath
  try {
    // Why first: a switch after a `--` terminator would be read as a positional.
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
