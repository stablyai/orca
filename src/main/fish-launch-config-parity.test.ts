/**
 * fish is launched from three independent places — the local PTY provider, the
 * daemon/SSH transport, and the relay running on a remote host. Each one used to grow
 * its own idea of how to start a shell, and the relay simply had no fish branch at all
 * (it fell through to bare `-l`), so an SSH user on fish lost the routed agent homes and
 * the shim PATH entry that the same code fixes locally.
 *
 * This file is the drift alarm: it fails if any one site starts fish differently from
 * the others, or stops sourcing its init text from `getFishInitCommand`.
 */
import { describe, expect, it } from 'vitest'
import {
  getAttributionShellLaunchConfig as getDaemonAttributionShellLaunchConfig,
  getShellReadyLaunchConfig as getDaemonShellReadyLaunchConfig
} from './daemon/shell-ready'
import {
  getAttributionShellLaunchConfig as getLocalPtyAttributionShellLaunchConfig,
  getShellReadyLaunchConfig as getLocalPtyShellReadyLaunchConfig
} from './providers/local-pty-shell-ready'
import { getRelayShellLaunchConfig } from '../relay/pty-shell-launch'
import { getFishInitCommand } from './shell-templates'

const FISH_PATH = '/opt/homebrew/bin/fish'
const SHELL_READY_MARKER = '\\033]777;orca-shell-ready\\007'
const RELAY_ENV = { HOME: '/home/tester' }

type LaunchShape = { args: string[]; env: Record<string, string> }

function shape(config: { args: string[] | null; env: Record<string, string> }): LaunchShape {
  return { args: config.args ?? [], env: config.env }
}

function launchShapes(emitReadyMarker: boolean): Record<string, LaunchShape> {
  return {
    local: shape(
      emitReadyMarker
        ? getLocalPtyShellReadyLaunchConfig(FISH_PATH)
        : getLocalPtyAttributionShellLaunchConfig(FISH_PATH)
    ),
    daemon: shape(
      emitReadyMarker
        ? getDaemonShellReadyLaunchConfig(FISH_PATH)
        : getDaemonAttributionShellLaunchConfig(FISH_PATH)
    ),
    relay: shape(getRelayShellLaunchConfig(FISH_PATH, RELAY_ENV, 'linux', { emitReadyMarker }))
  }
}

describe('fish launch config parity across the three launch sites', () => {
  for (const emitReadyMarker of [true, false]) {
    const label = emitReadyMarker ? 'shell-ready' : 'attribution-only'

    it(`starts ${label} fish identically from the local, daemon, and relay sites`, () => {
      const { local, daemon, relay } = launchShapes(emitReadyMarker)
      expect(daemon).toEqual(local)
      expect(relay).toEqual(local)
    })

    it(`hands ${label} fish the shared init text rather than a per-site copy`, () => {
      const expected = ['-l', '-C', getFishInitCommand(SHELL_READY_MARKER)]
      for (const [site, config] of Object.entries(launchShapes(emitReadyMarker))) {
        expect(config.args, site).toEqual(expected)
        // Why: the marker block is inert unless this is set, so a site that drops it
        // would look correct in the args diff and never emit a ready marker.
        expect(config.env, site).toEqual({
          ORCA_SHELL_READY_MARKER: emitReadyMarker ? '1' : '0'
        })
      }
    })
  }

  it('re-prepends every shim variable the three sites can plant', () => {
    const init = getFishInitCommand(SHELL_READY_MARKER)
    // ORCA_REMOTE_CLI_BIN_DIR is the relay's own name for the shim dir; the local sites
    // never set it and fish expands the unset name to nothing, which is what lets one
    // text serve all three.
    for (const variable of [
      'ORCA_ATTRIBUTION_SHIM_DIR',
      'ORCA_AGENT_TEAMS_SHIM_DIR',
      'ORCA_REMOTE_CLI_BIN_DIR'
    ]) {
      expect(init).toContain(`$${variable}`)
    }
    for (const variable of ['ORCA_OPENCODE_CONFIG_DIR', 'ORCA_MIMOCODE_HOME', 'ORCA_CODEX_HOME']) {
      expect(init).toContain(`$${variable}`)
    }
  })

  it('keeps non-fish relay shells on their existing launch shapes', () => {
    // Why: the fish branch sits ahead of the bash/zsh wrapper work, so a basename
    // mismatch there would silently disarm the overlay wrappers for everyone else.
    expect(getRelayShellLaunchConfig('/usr/bin/dash', RELAY_ENV, 'linux')).toEqual({
      args: ['-l'],
      env: {}
    })
  })
})
