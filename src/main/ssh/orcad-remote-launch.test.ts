import { describe, expect, it } from 'vitest'

import {
  ORCAD_READINESS_FILENAME,
  orcadLaunchCommand,
  orcadLivenessBlocksGc,
  orcadLivenessProbeCommand,
  OrcadRemoteLaunchUnsupportedError,
  parseOrcadLiveness,
  parseOrcadReadinessOutput
} from './orcad-remote-launch'
import {
  orcadStopFreedTheHost,
  parseOrcadStopOutcome,
  stopOrcadCommand
} from './orcad-remote-process-control'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const posix = getRemoteHostPlatform('linux-x64')
const windows = getRemoteHostPlatform('win32-x64')

const SPEC = {
  remoteInstallDir: '/home/u/.orca-remote/orcad-0.2.0+bb01',
  nodePath: '/usr/bin/node',
  fullVersion: '0.2.0+bb01',
  userDataDir: '/home/u/.orca',
  bindHost: '127.0.0.1',
  port: 7777
}

const READY_LINE = JSON.stringify({
  type: 'orca_server_ready',
  schemaVersion: 1,
  runtimeId: 'r1',
  boundEndpoint: 'ws://127.0.0.1:7777',
  advertisedEndpoint: null,
  managedWslCliReconciliation: 'settled',
  pairing: { available: false, reason: 'disabled_by_operator', guidance: 'n/a' },
  health: { buildHash: 'abc', terminalDaemon: { state: 'live' } }
})

describe('orcadLaunchCommand', () => {
  it('states the bind posture rather than inheriting the build default', () => {
    expect(orcadLaunchCommand(posix, SPEC)).toContain("--bind '127.0.0.1'")
  })

  it('truncates the readiness file, so a stale line cannot be activated on', () => {
    const command = orcadLaunchCommand(posix, SPEC)
    const truncate = command.indexOf(`: > '${SPEC.remoteInstallDir}/${ORCAD_READINESS_FILENAME}'`)
    const launch = command.indexOf('nohup')
    expect(truncate).toBeGreaterThan(-1)
    expect(truncate).toBeLessThan(launch)
  })

  it('exports the version and the shared data root the deploy decided on', () => {
    const command = orcadLaunchCommand(posix, SPEC)
    expect(command).toContain(`ORCA_VERSION '${SPEC.fullVersion}'`.replace(' ', '='))
    expect(command).toContain(`ORCA_USER_DATA='${SPEC.userDataDir}'`)
  })

  it('declares the Windows refusal instead of emitting a command that cannot work', () => {
    expect(() => orcadLaunchCommand(windows, SPEC)).toThrow(OrcadRemoteLaunchUnsupportedError)
  })
})

describe('readiness parsing', () => {
  it('extracts the orca_server_ready payload', () => {
    const parsed = parseOrcadReadinessOutput(`${READY_LINE}\n`)
    expect(parsed).toMatchObject({ state: 'ready' })
    expect(parsed.state === 'ready' && parsed.readiness.boundEndpoint).toBe('ws://127.0.0.1:7777')
  })

  it('treats an empty or half-written file as pending, not as a failure', () => {
    expect(parseOrcadReadinessOutput('')).toEqual({ state: 'pending' })
    expect(parseOrcadReadinessOutput('{"type":"orca_serv')).toEqual({ state: 'pending' })
  })

  it('reports a complete JSON line that is not a readiness payload as malformed', () => {
    expect(parseOrcadReadinessOutput('{"type":"something_else"}')).toMatchObject({
      state: 'malformed'
    })
  })
})

describe('liveness', () => {
  it('reads the pid recorded in the version dir', () => {
    expect(orcadLivenessProbeCommand(posix, SPEC.remoteInstallDir)).toContain('.orcad-pid')
  })

  it.each([
    ['LIVE', 'LIVE', true],
    ['DEAD', 'DEAD', false],
    ['', 'UNKNOWN', true],
    ['garbage', 'UNKNOWN', true]
  ])('parses %s and blocks GC = %s', (output, expected, blocks) => {
    expect(parseOrcadLiveness(output)).toBe(expected)
    expect(orcadLivenessBlocksGc(parseOrcadLiveness(output))).toBe(blocks)
  })
})

describe('stopping a running orcad', () => {
  it('sends SIGTERM and never SIGKILL', () => {
    const command = stopOrcadCommand(posix, SPEC.remoteInstallDir, { waitSeconds: 20 })
    expect(command).toContain('kill -TERM')
    for (const kill of ['kill -9', 'kill -KILL', 'kill -SIGKILL', 'pkill']) {
      expect(command).not.toContain(kill)
    }
  })

  it.each([
    ['STOPPED', 'stopped', true],
    ['ALREADY_EXITED', 'already-exited', true],
    ['NO_PID', 'no-pid', true],
    ['STILL_RUNNING', 'still-running', false],
    ['SIGNAL_FAILED', 'signal-failed', false],
    ['', 'unknown', false]
  ])('parses %s and frees the host = %s', (output, expected, frees) => {
    expect(parseOrcadStopOutcome(output)).toBe(expected)
    expect(orcadStopFreedTheHost(parseOrcadStopOutcome(output))).toBe(frees)
  })
})
