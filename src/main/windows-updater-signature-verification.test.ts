import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, osReleaseMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  osReleaseMock: vi.fn(() => '10.0.22631')
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...(actual as object),
    release: osReleaseMock
  }
})

import {
  EXPECTED_WINDOWS_UPDATE_SIGNER_THUMBPRINT,
  installWindowsUpdaterSignatureVerification,
  verifyWindowsUpdaterInstaller
} from './windows-updater-signature-verification'

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void

function mockPowerShellSuccess(): void {
  execFileMock.mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as ExecFileCallback
    callback(null, readPowerShellMockStdout(args), '')
  })
}

function mockPowerShellFailure(error: Error): void {
  execFileMock.mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as ExecFileCallback
    callback(error, '', '')
  })
}

function readPowerShellMockStdout(args: unknown[]): string {
  return readPowerShellCommand(args).includes('Get-AuthenticodeSignature -LiteralPath')
    ? JSON.stringify({
        Status: 0,
        Path: readLiteralPathFromCommand(args),
        SignerCertificate: {
          Subject: 'CN=SignPath Foundation, O=SignPath Foundation, L=Lewes, S=Delaware, C=US',
          Thumbprint: EXPECTED_WINDOWS_UPDATE_SIGNER_THUMBPRINT
        }
      })
    : ''
}

function readPowerShellCommand(args: unknown[]): string {
  const powerShellArgs = args[1]
  return Array.isArray(powerShellArgs) ? String(powerShellArgs.at(-1)) : ''
}

function readLiteralPathFromCommand(args: unknown[]): string {
  const command = readPowerShellCommand(args)
  return command.match(/-LiteralPath '((?:''|[^'])*)'/u)?.[1]?.replace(/''/gu, "'") ?? ''
}

describe('windows updater signature verification', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    osReleaseMock.mockReset().mockReturnValue('10.0.22631')
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    mockPowerShellSuccess()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('installs a Windows verifySignature hook using Orca Authenticode checks', async () => {
    const autoUpdater: {
      verifySignature?: (installerPath: string) => Promise<string | null>
    } = {}

    installWindowsUpdaterSignatureVerification(autoUpdater as never)

    await expect(autoUpdater.verifySignature?.('C:\\cache\\orca.exe')).resolves.toBeNull()
    expect(
      execFileMock.mock.calls.some((call) =>
        readPowerShellCommand(call).includes('Get-AuthenticodeSignature')
      )
    ).toBe(true)
  })

  it('does not call the upstream verifier that launches PowerShell through PATH', async () => {
    const verifyUpdateCodeSignature = vi.fn().mockResolvedValue(null)

    await expect(
      verifyWindowsUpdaterInstaller({ verifyUpdateCodeSignature } as never, 'C:\\cache\\orca.exe')
    ).resolves.toBeNull()

    expect(verifyUpdateCodeSignature).not.toHaveBeenCalled()
  })

  it('fails closed when the installer signature status is not valid', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as ExecFileCallback
      const stdout = readPowerShellCommand(args).includes('Get-AuthenticodeSignature')
        ? JSON.stringify({
            Status: 'NotSigned',
            Path: 'C:\\cache\\orca.exe',
            SignerCertificate: null
          })
        : ''
      callback(null, stdout, '')
    })

    await expect(verifyWindowsUpdaterInstaller({} as never, 'C:\\cache\\orca.exe')).resolves.toBe(
      'Windows update installer signature is not valid.'
    )
  })

  it('fails closed when the installer literal path does not match', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as ExecFileCallback
      const stdout = readPowerShellCommand(args).includes('Get-AuthenticodeSignature')
        ? JSON.stringify({
            Status: 0,
            Path: 'C:\\cache\\other.exe',
            SignerCertificate: {
              Subject: 'CN=SignPath Foundation',
              Thumbprint: EXPECTED_WINDOWS_UPDATE_SIGNER_THUMBPRINT
            }
          })
        : ''
      callback(null, stdout, '')
    })

    await expect(verifyWindowsUpdaterInstaller({} as never, 'C:\\cache\\orca.exe')).resolves.toBe(
      'Windows update installer literal path did not match the requested path.'
    )
  })

  it('fails closed when the installer publisher is not trusted', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as ExecFileCallback
      const stdout = readPowerShellCommand(args).includes('Get-AuthenticodeSignature')
        ? JSON.stringify({
            Status: 0,
            Path: 'C:\\cache\\orca.exe',
            SignerCertificate: {
              Subject: 'CN=Other Publisher',
              Thumbprint: EXPECTED_WINDOWS_UPDATE_SIGNER_THUMBPRINT
            }
          })
        : ''
      callback(null, stdout, '')
    })

    await expect(verifyWindowsUpdaterInstaller({} as never, 'C:\\cache\\orca.exe')).resolves.toBe(
      'Windows update installer publisher is not trusted.'
    )
  })

  it('fails closed when the Authenticode probe times out', async () => {
    vi.useFakeTimers()
    execFileMock
      .mockImplementationOnce((...args: unknown[]) => {
        ;(args.at(-1) as ExecFileCallback)(null, '', '')
      })
      .mockImplementationOnce((...args: unknown[]) => {
        ;(args.at(-1) as ExecFileCallback)(null, '', '')
      })
      .mockImplementationOnce((...args: unknown[]) => {
        ;(args.at(-1) as ExecFileCallback)(null, '', '')
      })
      .mockImplementationOnce(() => ({ kill: vi.fn() }))

    const verification = verifyWindowsUpdaterInstaller({} as never, 'C:\\cache\\orca.exe')

    await vi.runOnlyPendingTimersAsync()

    await expect(verification).resolves.toContain(
      'Windows update signer thumbprint check timed out.'
    )
  })

  it('leaves updater methods untouched on non-Windows platforms', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    const verifySignature = vi.fn()
    const autoUpdater = { verifySignature }

    installWindowsUpdaterSignatureVerification(autoUpdater as never)

    expect(autoUpdater.verifySignature).toBe(verifySignature)
  })

  it('no-ops verifier calls on non-Windows platforms', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })

    await expect(
      verifyWindowsUpdaterInstaller({} as never, '/tmp/orca.AppImage')
    ).resolves.toBeNull()
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('fails closed on unsupported old Windows 6.x releases except 6.3', async () => {
    osReleaseMock.mockReturnValue('6.2.9200')

    await expect(
      verifyWindowsUpdaterInstaller({} as never, 'C:\\cache\\orca.exe')
    ).resolves.toContain('cannot run the update signature verifier safely')
  })

  it('allows Windows 6.3 through the capability preflight', async () => {
    osReleaseMock.mockReturnValue('6.3.9600')

    await expect(
      verifyWindowsUpdaterInstaller({} as never, 'C:\\cache\\orca.exe')
    ).resolves.toBeNull()
  })

  it('fails closed when PowerShell cannot run', async () => {
    mockPowerShellFailure(new Error('powershell missing'))

    await expect(
      verifyWindowsUpdaterInstaller({} as never, 'C:\\cache\\orca.exe')
    ).resolves.toContain('PowerShell could not run')
  })

  it('runs system PowerShell without inheriting PATH during verification', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    vi.stubEnv('Path', 'C:\\malicious')
    vi.stubEnv('PATH', 'C:\\malicious')

    await expect(
      verifyWindowsUpdaterInstaller({} as never, 'C:\\cache\\orca.exe')
    ).resolves.toBeNull()

    const firstCall = execFileMock.mock.calls[0]
    expect(firstCall?.[0]).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(firstCall?.[2]).toMatchObject({
      env: expect.objectContaining({
        PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
        SystemRoot: 'C:\\Windows',
        windir: 'C:\\Windows'
      }),
      windowsHide: true
    })
    expect((firstCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env).not.toHaveProperty(
      'Path'
    )
    expect((firstCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env).not.toHaveProperty(
      'PATH'
    )
  })

  it('fails closed when the PowerShell preflight times out', async () => {
    vi.useFakeTimers()
    execFileMock.mockImplementation(() => ({ kill: vi.fn() }))

    const verification = verifyWindowsUpdaterInstaller({} as never, 'C:\\cache\\orca.exe')

    await vi.runOnlyPendingTimersAsync()

    await expect(verification).resolves.toContain('PowerShell could not run')
  })

  it('fails closed when Get-AuthenticodeSignature cannot run', async () => {
    execFileMock
      .mockImplementationOnce((...args: unknown[]) => {
        ;(args.at(-1) as ExecFileCallback)(null, '', '')
      })
      .mockImplementationOnce((...args: unknown[]) => {
        ;(args.at(-1) as ExecFileCallback)(new Error('missing command'), '', '')
      })

    await expect(
      verifyWindowsUpdaterInstaller({} as never, 'C:\\cache\\orca.exe')
    ).resolves.toContain('Get-AuthenticodeSignature could not run')
  })

  it('fails closed when ConvertTo-Json cannot run', async () => {
    execFileMock
      .mockImplementationOnce((...args: unknown[]) => {
        ;(args.at(-1) as ExecFileCallback)(null, '', '')
      })
      .mockImplementationOnce((...args: unknown[]) => {
        ;(args.at(-1) as ExecFileCallback)(null, '', '')
      })
      .mockImplementationOnce((...args: unknown[]) => {
        ;(args.at(-1) as ExecFileCallback)(new Error('missing json'), '', '')
      })

    await expect(
      verifyWindowsUpdaterInstaller({} as never, 'C:\\cache\\orca.exe')
    ).resolves.toContain('ConvertTo-Json could not run')
  })

  it('fails closed when the installer signer thumbprint is not trusted', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as ExecFileCallback
      const stdout = readPowerShellCommand(args).includes('Get-AuthenticodeSignature -LiteralPath')
        ? JSON.stringify({
            Status: 0,
            Path: 'C:\\cache\\orca.exe',
            SignerCertificate: {
              Subject: 'CN=SignPath Foundation',
              Thumbprint: '0000000000000000000000000000000000000000'
            }
          })
        : ''
      callback(null, stdout, '')
    })

    await expect(verifyWindowsUpdaterInstaller({} as never, 'C:\\cache\\orca.exe')).resolves.toBe(
      'Windows update installer signer thumbprint is not trusted.'
    )
  })

  it('escapes single quotes in installer paths before the thumbprint check', async () => {
    await expect(
      verifyWindowsUpdaterInstaller({} as never, "C:\\cache\\orca's.exe")
    ).resolves.toBeNull()

    expect(
      execFileMock.mock.calls
        .map((call) => readPowerShellCommand(call))
        .some((command) => command.includes("-LiteralPath 'C:\\cache\\orca''s.exe'"))
    ).toBe(true)
  })
})
