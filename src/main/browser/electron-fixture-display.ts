import { existsSync } from 'node:fs'
import { runProcessSync } from '../../shared/child-process/run-process'

/**
 * Where an Electron fixture can find a display on this host.
 *
 * Why: CI installs xvfb, a developer workstation usually does not but has a real X
 * server already running. Hardcoding `xvfb-run` turns the second case into
 * `spawnSync xvfb-run ENOENT`, which reads like a broken test rather than a missing
 * package. Prefer a private virtual display, fall back to the session's own.
 */
export type ElectronFixtureLaunch = {
  command: string
  args: string[]
  display: 'xvfb' | 'host' | 'native'
}

function hasXvfbRun(): boolean {
  try {
    return runProcessSync({ program: 'xvfb-run', args: ['--help'] }).code === 0
  } catch {
    return false
  }
}

/** A display is usable only when both the variable and its socket are present. */
export function hostDisplaySocket(): string | null {
  const display = process.env.DISPLAY?.trim()
  const screen = display?.match(/^:(\d+)/)?.[1]
  if (!display || screen === undefined) {
    return null
  }
  const socket = `/tmp/.X11-unix/X${screen}`
  return existsSync(socket) ? socket : null
}

export function resolveElectronFixtureLaunch(
  electronBinary: string,
  electronArgs: string[]
): ElectronFixtureLaunch {
  if (process.platform !== 'linux') {
    return { command: electronBinary, args: electronArgs, display: 'native' }
  }
  if (hasXvfbRun()) {
    return {
      command: 'xvfb-run',
      args: ['--auto-servernum', electronBinary, ...electronArgs, '--no-sandbox'],
      display: 'xvfb'
    }
  }
  if (!hostDisplaySocket()) {
    throw new Error(
      'No display for the Electron fixture: xvfb-run is not installed and DISPLAY has no matching /tmp/.X11-unix socket.'
    )
  }
  // Why --no-sandbox here too: the fixture runs an unpackaged Electron from a temp
  // directory, which cannot use the setuid sandbox helper.
  return { command: electronBinary, args: [...electronArgs, '--no-sandbox'], display: 'host' }
}
