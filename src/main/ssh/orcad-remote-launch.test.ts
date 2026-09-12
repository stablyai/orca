import { describe, expect, it } from 'vitest'

import {
  ORCAD_READINESS_FILENAME,
  orcadLaunchCommand,
  orcadLivenessBlocksGc,
  orcadLivenessProbeCommand,
  parseOrcadLiveness,
  parseOrcadReadinessOutput,
  readOrcadReadinessCommand
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
  health: {
    buildHash: 'abc123def4567890',
    buildVersion: '0.2.0+bb01',
    nodeVersion: '24.3.0',
    nodeAbi: '137',
    runtimeKind: 'bun',
    runtimeVersion: '1.4.0',
    ptyBackend: 'bun-terminal',
    platform: 'linux',
    arch: 'x64',
    pid: 4200,
    terminalDaemon: {
      state: 'live',
      ownsFreshSessions: true,
      pid: 4242,
      buildVersion: '0.2.0+bb01',
      entryPath: '/home/u/.orca-remote/orcad-0.2.0+bb01/daemon-entry.js',
      protocolVersion: 36,
      selfTest: { ok: true, coverage: 'pty-spawn', verdict: 'healthy', durationMs: 10 }
    }
  }
})

function decodePowerShellCommand(command: string): string {
  const encoded = command.trim().split(/\s+/).at(-1) ?? ''
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

describe('orcadLaunchCommand', () => {
  it('states the bind posture rather than inheriting the build default', () => {
    expect(orcadLaunchCommand(posix, SPEC)).toContain("--bind '127.0.0.1'")
  })

  it('truncates the readiness file, so a stale line cannot be activated on', () => {
    const command = orcadLaunchCommand(posix, SPEC)
    const umask = command.indexOf('umask 077')
    const clearStopRequest = command.indexOf('rm -f')
    const truncate = command.indexOf(`: > '${SPEC.remoteInstallDir}/${ORCAD_READINESS_FILENAME}'`)
    const launch = command.indexOf('nohup')
    expect(umask).toBeGreaterThan(-1)
    expect(clearStopRequest).toBeGreaterThan(umask)
    expect(clearStopRequest).toBeLessThan(truncate)
    expect(umask).toBeLessThan(truncate)
    expect(truncate).toBeGreaterThan(-1)
    expect(truncate).toBeLessThan(launch)
  })

  it('exports the version and the shared data root the deploy decided on', () => {
    const command = orcadLaunchCommand(posix, SPEC)
    expect(command).toContain(`ORCA_VERSION '${SPEC.fullVersion}'`.replace(' ', '='))
    expect(command).toContain(`ORCA_USER_DATA='${SPEC.userDataDir}'`)
  })

  it('requires the bundled Bun runtime for a new candidate', () => {
    const command = orcadLaunchCommand(posix, SPEC)
    expect(command).toContain('bundled Bun runtime is missing')
    expect(command).not.toContain("ORCAD_RUNTIME='/usr/bin/node'")
  })

  it('allows a host-Node fallback only for rollback to a pre-Bun slot', () => {
    const command = orcadLaunchCommand(posix, { ...SPEC, allowHostNodeFallback: true })
    expect(command).toContain("ORCAD_RUNTIME='/usr/bin/node'")
  })

  it('launches the bundled runtime detached on Windows', () => {
    const script = decodePowerShellCommand(orcadLaunchCommand(windows, SPEC))
    expect(script).toContain('Start-Process')
    expect(script).toContain("bun-runtime.exe'")
    expect(script).toContain('extensionless Windows Bun slot must be rebuilt')
    expect(script).not.toContain('Copy-Item')
    expect(script).toContain('RedirectStandardOutput')
    expect(script).toContain('.orcad-pid')
    expect(script).not.toContain(SPEC.nodePath)
  })

  it('allows Windows rollback to a pre-Bun Node slot', () => {
    const script = decodePowerShellCommand(
      orcadLaunchCommand(windows, { ...SPEC, allowHostNodeFallback: true })
    )
    expect(script).toContain(`$runtime = '${SPEC.nodePath}'`)
  })
})

describe('readiness parsing', () => {
  it('reads the readiness file with PowerShell on Windows', () => {
    const script = decodePowerShellCommand(
      readOrcadReadinessCommand(windows, SPEC.remoteInstallDir)
    )
    expect(script).toContain('[IO.File]::ReadAllText')
    expect(script).toContain(ORCAD_READINESS_FILENAME)
  })

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

  it('reports a complete readiness line with an invalid nested health shape as malformed', () => {
    expect(
      parseOrcadReadinessOutput(
        `${JSON.stringify({ ...JSON.parse(READY_LINE), health: { terminalDaemon: null } })}\n`
      )
    ).toMatchObject({ state: 'malformed' })
  })

  it('reports a complete malformed JSON line instead of polling it forever', () => {
    expect(parseOrcadReadinessOutput('{"type":"orca_server_ready",}\n')).toMatchObject({
      state: 'malformed'
    })
  })

  it('rejects a readiness file that exceeds the bounded handshake size', () => {
    expect(parseOrcadReadinessOutput(`{${'x'.repeat(256 * 1024)}}`)).toMatchObject({
      state: 'malformed'
    })
  })
})

describe('liveness', () => {
  it('reads the pid recorded in the version dir', () => {
    expect(orcadLivenessProbeCommand(posix, SPEC.remoteInstallDir)).toContain('.orcad-pid')
  })

  it('uses Get-Process rather than POSIX signals on Windows', () => {
    const script = decodePowerShellCommand(
      orcadLivenessProbeCommand(windows, SPEC.remoteInstallDir)
    )
    expect(script).toContain('Get-Process')
    expect(script).toContain("Write-Output 'LIVE'")
    expect(script).not.toContain('kill -0')
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
  it('uses a slot-local request and never signals a possibly reused POSIX PID', () => {
    const command = stopOrcadCommand(posix, SPEC.remoteInstallDir, { waitSeconds: 20 })
    expect(command).toContain('.orcad-stop-request')
    for (const kill of ['kill -TERM', 'kill -9', 'kill -KILL', 'kill -SIGKILL', 'pkill']) {
      expect(command).not.toContain(kill)
    }
  })

  it('requests graceful Windows teardown without Stop-Process', () => {
    const script = decodePowerShellCommand(
      stopOrcadCommand(windows, SPEC.remoteInstallDir, { waitSeconds: 20 })
    )
    expect(script).toContain('.orcad-stop-request')
    expect(script).toContain('Get-Process')
    expect(script).not.toContain('Stop-Process')
    expect(script).not.toContain('taskkill')
  })

  it.each([
    ['STOPPED', 'stopped', true],
    ['ALREADY_EXITED', 'already-exited', true],
    ['NO_PID', 'no-pid', false],
    ['STILL_RUNNING', 'still-running', false],
    ['SIGNAL_FAILED', 'signal-failed', false],
    ['', 'unknown', false]
  ])('parses %s and frees the host = %s', (output, expected, frees) => {
    expect(parseOrcadStopOutcome(output)).toBe(expected)
    expect(orcadStopFreedTheHost(parseOrcadStopOutcome(output))).toBe(frees)
  })
})
