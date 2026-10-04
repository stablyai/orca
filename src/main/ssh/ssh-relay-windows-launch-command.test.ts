import { describe, expect, it } from 'vitest'
import {
  formatRelayWindowsLaunchReport,
  parseRelayWindowsLaunchReport,
  RELAY_WINDOWS_BREAKAWAY_LAUNCH_FLAG
} from '../../shared/relay-windows-breakaway-launch'
import {
  classifyWindowsRelayLaunchError,
  WINDOWS_RELAY_LAUNCH_REFUSED_MARKER,
  windowsRelayLaunchCommand
} from './ssh-relay-windows-launch-command'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { decodeRemotePowerShellScript } from './ssh-remote-powershell'

const host = getRemoteHostPlatform('win32-x64')
const opts = {
  nodePath: 'C:/Users/me user/.orca-remote/runtimes/node-abc/node.exe',
  remoteDir: 'C:/Users/me user/.orca-remote/relay-1',
  sockPath: '\\\\.\\pipe\\orca-relay-1',
  endpointDir: 'C:/Users/me user/.orca-remote/relay-1/agent-hooks/orca-relay-1',
  graceTime: 300,
  logFile: 'C:/Users/me user/.orca-remote/relay-1/relay.log',
  errFile: 'C:/Users/me user/.orca-remote/relay-1/relay.err.log',
  credentialFile: 'C:/Users/me user/.orca-remote/relay-1/orca-relay-1.credential'
}

function launchScript(): string {
  return decodeRemotePowerShellScript(windowsRelayLaunchCommand(host, opts))
}

describe('windowsRelayLaunchCommand', () => {
  it('starts the relay through the breakaway launcher on the same node.exe', () => {
    const script = launchScript()
    const launcher = `& '${opts.nodePath}' relay.js '${RELAY_WINDOWS_BREAKAWAY_LAUNCH_FLAG}' '--stdout-file' '${opts.logFile}' '--stderr-file' '${opts.errFile}' '--relay-args' '--detached' '--grace-time' '300' '--sock-path' '${opts.sockPath}'`
    expect(script).toContain(launcher)
    expect(script.indexOf(launcher)).toBeLessThan(script.indexOf('Invoke-CimMethod'))
  })

  it('reaches WMI only when the launcher reports itself unavailable', () => {
    const script = launchScript()
    const wmiBranch = script.slice(script.indexOf('if ($orcaLaunchCode -eq 3)'))
    expect(wmiBranch.indexOf('Invoke-CimMethod')).toBeGreaterThan(0)
    expect(wmiBranch.indexOf('Invoke-CimMethod')).toBeLessThan(wmiBranch.indexOf('elseif'))
    expect(script).toContain(
      `"C:/Users/me user/.orca-remote/relay-1/relay.js" --detached --grace-time 300`
    )
    expect(script).toContain(`1>"${opts.logFile}" 2>"${opts.errFile}"`)
  })

  it('names a WMI refusal so a standard-user host fails with a reason', () => {
    const script = launchScript()
    expect(script).toContain(`throw "${WINDOWS_RELAY_LAUNCH_REFUSED_MARKER}:`)
    expect(script).toContain('Invoke-CimMethod -ErrorAction Stop')
  })

  it('emits nothing an EDR scores as a launch technique', () => {
    const script = launchScript()
    expect(script).not.toMatch(/Add-Type|ExecutionPolicy|Register-ScheduledTask|schtasks/iu)
  })

  it('passes the uploaded ripgrep to both routes', () => {
    const script = decodeRemotePowerShellScript(
      windowsRelayLaunchCommand(host, { ...opts, ripgrepPath: 'C:/rg/rg.exe' })
    )
    expect(script).toContain(`'--ripgrep-path' 'C:/rg/rg.exe'`)
    expect(script).toContain('--ripgrep-path "C:/rg/rg.exe"')
  })
})

describe('classifyWindowsRelayLaunchError', () => {
  it('turns a refusal into a named error', () => {
    const exec = new Error(
      `Command "powershell.exe -EncodedCommand AAAA" failed (exit 1): ${WINDOWS_RELAY_LAUNCH_REFUSED_MARKER}: this account cannot start a process that outlives the SSH session: breakaway launcher unavailable (ORCA_RELAY_LAUNCH {"method":"unavailable","reason":"addon-missing"}) and WMI Win32_Process.Create denied (Access denied)\nAt line:1 char:1`
    )
    const classified = classifyWindowsRelayLaunchError(exec)
    if (!(classified instanceof Error)) {
      throw new Error('expected an Error')
    }
    expect(classified.message).toMatch(
      /^The Windows host refused to start Orca's relay outside the SSH session\. ORCA_RELAY_LAUNCH_REFUSED: .*addon-missing.*Access denied\)$/u
    )
    expect(classified.message).not.toContain('EncodedCommand')
  })

  it('leaves every other launch failure as it was', () => {
    const exec = new Error('Command "x" failed (exit 1): Relay launcher exited 1')
    expect(classifyWindowsRelayLaunchError(exec)).toBe(exec)
  })
})

describe('parseRelayWindowsLaunchReport', () => {
  it('reads the launcher and WMI reports', () => {
    const breakaway = formatRelayWindowsLaunchReport({ method: 'breakaway', pid: 7, inJob: false })
    expect(parseRelayWindowsLaunchReport(`noise\r\n${breakaway}\r\n`)).toEqual({
      method: 'breakaway',
      pid: 7,
      inJob: false
    })
    const unavailable = formatRelayWindowsLaunchReport({
      method: 'unavailable',
      reason: 'addon-missing'
    })
    expect(
      parseRelayWindowsLaunchReport(`${unavailable}\nORCA_RELAY_LAUNCH {"method":"wmi"}`)
    ).toEqual({ method: 'wmi' })
  })

  it('reads nothing from output without a report', () => {
    expect(parseRelayWindowsLaunchReport('')).toBeNull()
    expect(parseRelayWindowsLaunchReport('ORCA_RELAY_LAUNCH not-json')).toBeNull()
    expect(parseRelayWindowsLaunchReport('ORCA_RELAY_LAUNCH {"method":"breakaway"}')).toBeNull()
  })
})
