import { describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import {
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
  it('doubles typographic single quotes in the executable literal', async () => {
    const runPowerShell = vi.fn().mockResolvedValue('not json')
    await inspectWindowsMobileFirewall(
      6768,
      '192.168.0.108',
      environment(runPowerShell, { executablePath: 'C:\\Users\\O\u2019Brien\\Orca\\Orca.exe' })
    )
    expect(runPowerShell.mock.calls[0]![0]).toContain(
      "-Program 'C:\\Users\\O\u2019\u2019Brien\\Orca\\Orca.exe'"
    )
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

  it('keeps the elevated child encoded because Start-Process re-splits its ArgumentList', async () => {
    // Elevated Start-Process joins/re-splits argv and collapses spaces in executable paths; only this hop needs base64.
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
    // Direct CreateProcess argv preserves spaces without encoding; -EncodedCommand here only adds EDR signal.
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
})
