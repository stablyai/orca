import { describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import {
  getWebSocketPort,
  inspectWindowsMobileFirewall,
  repairWindowsMobileFirewall,
  type WindowsMobileFirewallEnvironment
} from './windows-mobile-firewall'

// Why: every other case injects `runPowerShell`, so only the argv case below reaches execFile.
vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

function environment(
  runPowerShell: WindowsMobileFirewallEnvironment['runPowerShell'],
  overrides: Partial<WindowsMobileFirewallEnvironment> = {}
): WindowsMobileFirewallEnvironment {
  return {
    platform: 'win32',
    isPackaged: true,
    executablePath: "C:\\Users\\O'Brien\\Orca\\Orca.exe",
    systemRoot: 'C:\\Windows',
    runPowerShell,
    ...overrides
  }
}

describe('windows mobile firewall', () => {
  it('inspects the exact executable, port, and selected interface profile', async () => {
    const runPowerShell = vi.fn().mockResolvedValue(
      JSON.stringify({
        matchingRuleScopes: [{ remoteAddresses: ['192.168.0.0/24'] }],
        blockingRuleDetected: false,
        localAddress: '192.168.0.108',
        localPrefixLength: 24,
        privateFirewallEnabled: true,
        networkCategory: 'Private'
      })
    )

    await expect(
      inspectWindowsMobileFirewall(6768, '192.168.0.108', environment(runPowerShell))
    ).resolves.toEqual({
      supported: true,
      port: 6768,
      ruleAllowed: true,
      blockingRuleDetected: false,
      privateFirewallEnabled: true,
      networkCategory: 'private',
      inspectionAvailable: true
    })

    const script = runPowerShell.mock.calls[0]![0] as string
    // Why: without ActiveStore, GPO-applied Block rules are invisible and the
    // post-repair re-inspection could report a false success on managed hosts.
    expect(script).toContain(
      "Get-NetFirewallApplicationFilter -PolicyStore ActiveStore -Program 'C:\\Users\\O''Brien\\Orca\\Orca.exe'"
    )
    expect(script).toContain('Get-NetFirewallProfile -PolicyStore ActiveStore -Name Private')
    expect(script).toContain("LocalPort | Where-Object { [string]$_ -eq 'Any'")
    expect(script).toContain("[string]$_ -eq '6768'")
    expect(script).toContain("C:\\Users\\O''Brien\\Orca\\Orca.exe")
    expect(script).toContain("$profile -match 'Private'")
    expect(script).toContain("Get-NetIPAddress -IPAddress '192.168.0.108'")
    expect(script).toContain('Get-NetFirewallAddressFilter')
    expect(script).toContain("[string]$rule.Action -eq 'Block'")
    expect(script).toContain('remoteAddresses = @($addressFilter.RemoteAddress')
    expect(script).toContain('$localPrefixLength = [int]$ip.PrefixLength')
  })

  it('treats an overlapping inbound Block rule as overriding a matching Allow rule', async () => {
    const runPowerShell = vi.fn().mockResolvedValue(
      JSON.stringify({
        matchingRuleScopes: [{ remoteAddresses: ['Any'] }],
        blockingRuleDetected: true,
        localAddress: '192.168.0.108',
        localPrefixLength: 24,
        privateFirewallEnabled: true,
        networkCategory: 'Private'
      })
    )

    await expect(
      inspectWindowsMobileFirewall(6768, '192.168.0.108', environment(runPowerShell))
    ).resolves.toEqual({
      supported: true,
      port: 6768,
      ruleAllowed: false,
      blockingRuleDetected: true,
      privateFirewallEnabled: true,
      networkCategory: 'private',
      inspectionAvailable: true
    })
  })

  it('does not accept a qualifying rule whose remote-address scope excludes the phone subnet', async () => {
    const runPowerShell = vi.fn().mockResolvedValue(
      JSON.stringify({
        matchingRuleScopes: [{ remoteAddresses: ['192.168.1.0/24'] }],
        localAddress: '192.168.0.108',
        localPrefixLength: 24,
        privateFirewallEnabled: true,
        networkCategory: 'Private'
      })
    )

    await expect(
      inspectWindowsMobileFirewall(6768, '192.168.0.108', environment(runPowerShell))
    ).resolves.toMatchObject({
      supported: true,
      ruleAllowed: false,
      inspectionAvailable: true
    })
  })

  it('does not support non-Windows or unpackaged development builds', async () => {
    const runPowerShell = vi.fn()
    await expect(
      inspectWindowsMobileFirewall(
        6768,
        undefined,
        environment(runPowerShell, { platform: 'darwin' })
      )
    ).resolves.toEqual({ supported: false })
    await expect(
      repairWindowsMobileFirewall(6768, environment(runPowerShell, { isPackaged: false }))
    ).resolves.toEqual({ ok: false, reason: 'unsupported' })
    expect(runPowerShell).not.toHaveBeenCalled()
  })

  it('returns an actionable status when inspection is unavailable', async () => {
    await expect(
      inspectWindowsMobileFirewall(
        6768,
        undefined,
        environment(vi.fn().mockRejectedValue(new Error('managed policy')))
      )
    ).resolves.toEqual({
      supported: true,
      port: 6768,
      ruleAllowed: false,
      blockingRuleDetected: false,
      privateFirewallEnabled: true,
      networkCategory: 'unknown',
      inspectionAvailable: false
    })
  })

  it('returns an actionable status for malformed or empty PowerShell output', async () => {
    for (const stdout of ['', 'not json']) {
      await expect(
        inspectWindowsMobileFirewall(
          6768,
          undefined,
          environment(vi.fn().mockResolvedValue(stdout))
        )
      ).resolves.toMatchObject({
        supported: true,
        ruleAllowed: false,
        inspectionAvailable: false
      })
    }
  })

  it('repairs only Orca mobile pairing on private networks after elevation', async () => {
    const runPowerShell = vi.fn().mockResolvedValue('{"launched":true,"exitCode":0}')
    await expect(repairWindowsMobileFirewall(6769, environment(runPowerShell))).resolves.toEqual({
      ok: true
    })

    const outerScript = runPowerShell.mock.calls[0]![0] as string
    const encoded = outerScript.match(/'-EncodedCommand', '([^']+)'/)?.[1]
    expect(encoded).toBeTruthy()
    const repairScript = Buffer.from(encoded!, 'base64').toString('utf16le')
    expect(repairScript).toContain("-Name 'Orca.MobilePairing'")
    expect(repairScript).toContain(
      "Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' }"
    )
    expect(repairScript).toContain('$rule | Remove-NetFirewallRule')
    expect(repairScript).toContain('-Profile Private')
    expect(repairScript).toContain('-Protocol TCP')
    expect(repairScript).toContain('-LocalPort 6769')
    expect(repairScript).toContain("-Program 'C:\\Users\\O''Brien\\Orca\\Orca.exe'")
    expect(repairScript).toContain('-EdgeTraversalPolicy Block')
  })

  it('keeps the elevated child encoded because Start-Process re-splits its ArgumentList', async () => {
    // Why: `Start-Process -ArgumentList` joins the array into one ShellExecuteEx parameter
    // string without quoting and PowerShell re-splits it on whitespace, which collapses runs
    // of spaces. Measured on Windows 11: a `-Command` payload turned `C:\My  App\Orca.exe`
    // into `C:\My App\Orca.exe`, i.e. a firewall rule for the wrong program. Base64 is the
    // only form that survives that hop, so this site must not follow the local runner.
    const runPowerShell = vi.fn().mockResolvedValue('{"launched":true,"exitCode":0}')
    await repairWindowsMobileFirewall(
      6769,
      environment(runPowerShell, { executablePath: 'C:\\My  App\\Orca.exe' })
    )

    const outerScript = runPowerShell.mock.calls[0]![0] as string
    expect(outerScript).toContain("'-EncodedCommand'")
    expect(outerScript).not.toContain("'-Command'")
    expect(outerScript).toContain('-Verb RunAs')

    const encoded = outerScript.match(/'-EncodedCommand', '([^']+)'/)?.[1]
    const repairScript = Buffer.from(encoded!, 'base64').toString('utf16le')
    expect(repairScript).toContain("-Program 'C:\\My  App\\Orca.exe'")
  })

  it('runs the local PowerShell over argv with a plain -Command script', async () => {
    // Why: execFile reaches CreateProcess with no shell in between, so the script needs no
    // base64 armouring, and argv preserves runs of spaces that the elevated hop cannot.
    // `-EncodedCommand` here was pure EDR signal.
    const execFileMock = vi.mocked(execFile)
    execFileMock.mockImplementation(((_file, _args, _options, callback) => {
      callback(null, '{"privateFirewallEnabled":true,"networkCategory":"Private"}', '')
      return {}
    }) as unknown as typeof execFile)

    await inspectWindowsMobileFirewall(6768, undefined, {
      platform: 'win32',
      isPackaged: true,
      executablePath: 'C:\\My  App\\Orca.exe',
      systemRoot: 'C:\\Windows'
    })

    const [file, args] = execFileMock.mock.calls[0]!
    expect(file).toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe$/i)
    expect(args!.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    expect(args).not.toContain('-EncodedCommand')
    expect(args).not.toContain('-ExecutionPolicy')
    // The script travels as ONE argv element, so its spaces and newlines survive verbatim.
    expect(args).toHaveLength(4)
    expect(args![3]).toContain("-Program 'C:\\My  App\\Orca.exe'")
    expect(args![3]).toContain('\n')
  })

  it('distinguishes a cancelled UAC prompt from repair failure', async () => {
    await expect(
      repairWindowsMobileFirewall(
        6768,
        environment(vi.fn().mockResolvedValue('{"launched":false,"nativeErrorCode":1223}'))
      )
    ).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('extracts only explicit valid websocket ports', () => {
    expect(getWebSocketPort('ws://0.0.0.0:6768')).toBe(6768)
    expect(getWebSocketPort('ws://0.0.0.0')).toBeNull()
    expect(getWebSocketPort('not a url')).toBeNull()
  })
})
