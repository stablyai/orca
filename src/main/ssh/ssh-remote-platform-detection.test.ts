import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'
import { SSH_EXEC_TIMEOUT_CODE } from './ssh-relay-exec-command'

const execCommandMock = vi.hoisted(() => vi.fn())

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: execCommandMock
}))

const { detectRemoteHostPlatform } = await import('./ssh-remote-platform-detection')

const conn = {} as SshConnection

function decodePowerShellCommand(command: string): string {
  const match = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/)
  return match ? Buffer.from(match[1], 'base64').toString('utf16le') : ''
}

/** OpenSSH refuses session channels past MaxSessions with reason 2 + "open failed". */
function maxSessionsError(): Error {
  return Object.assign(new Error('(SSH) Channel open failure: open failed'), { reason: 2 })
}

describe('detectRemoteHostPlatform', () => {
  beforeEach(() => {
    execCommandMock.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('detects POSIX hosts from uname output', async () => {
    execCommandMock.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux   x86_64\n')

    await expect(detectRemoteHostPlatform(conn)).resolves.toMatchObject({
      relayPlatform: 'linux-x64',
      os: 'linux',
      arch: 'x64',
      pathFlavor: 'posix'
    })
    expect(execCommandMock).toHaveBeenCalledWith(
      conn,
      "printf '\\n%s ' '__ORCA_REMOTE_PLATFORM__'; uname -sm"
    )
  })

  it('falls back to PowerShell detection for Windows remotes', async () => {
    execCommandMock
      .mockRejectedValueOnce(new Error('uname unavailable'))
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Windows AMD64\r\n')

    await expect(detectRemoteHostPlatform(conn)).resolves.toMatchObject({
      relayPlatform: 'win32-x64',
      os: 'win32',
      arch: 'x64',
      pathFlavor: 'windows'
    })
    expect(execCommandMock).toHaveBeenNthCalledWith(
      2,
      conn,
      expect.stringContaining('powershell.exe'),
      { wrapCommand: false }
    )
    const command = execCommandMock.mock.calls[1]?.[1] ?? ''
    expect(decodePowerShellCommand(command)).toContain(
      'Write-Output ("`n__ORCA_REMOTE_PLATFORM__ Windows " + $arch)'
    )
  })

  it('ignores untagged platforms before the tagged Windows ARM64 result', async () => {
    execCommandMock
      .mockRejectedValueOnce(new Error('uname unavailable'))
      .mockResolvedValueOnce(
        'Linux x86_64\r\nWindows AMD64\r\n#< CLIXML\r\n' +
          '__ORCA_REMOTE_PLATFORM__ Windows ARM64\r\n'
      )

    await expect(detectRemoteHostPlatform(conn)).resolves.toMatchObject({
      relayPlatform: 'win32-arm64',
      os: 'win32',
      arch: 'arm64',
      pathFlavor: 'windows'
    })
  })

  it('ignores a marker concatenated to unterminated startup noise', async () => {
    execCommandMock.mockResolvedValueOnce(
      'startup noise__ORCA_REMOTE_PLATFORM__ Linux x86_64\n' +
        '__ORCA_REMOTE_PLATFORM__ Linux arm64\n'
    )

    await expect(detectRemoteHostPlatform(conn)).resolves.toMatchObject({
      relayPlatform: 'linux-arm64'
    })
  })

  it('returns null when neither probe yields a supported platform', async () => {
    execCommandMock
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux')
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ FreeBSD x86_64')

    await expect(detectRemoteHostPlatform(conn)).resolves.toBeNull()
  })

  it('does not use whitespace regex splitting for remote platform output', async () => {
    const splitSpy = vi.spyOn(String.prototype, 'split')
    execCommandMock.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Darwin      arm64 extra')

    await expect(detectRemoteHostPlatform(conn)).resolves.toMatchObject({
      relayPlatform: 'darwin-arm64'
    })

    const usedWhitespaceFieldSplit = splitSpy.mock.calls.some(
      ([separator]) => separator instanceof RegExp && separator.source.includes('\\s+')
    )
    splitSpy.mockRestore()
    expect(usedWhitespaceFieldSplit).toBe(false)
  })
})

describe('detectRemoteHostPlatform failure reporting', () => {
  beforeEach(() => {
    execCommandMock.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not misreport a refused exec channel as an unsupported platform', async () => {
    execCommandMock.mockRejectedValue(maxSessionsError())

    // The host is linux-x64 and fully supported; the probe never ran.
    await expect(detectRemoteHostPlatform(conn)).rejects.toThrow(/open failed/iu)
    await expect(detectRemoteHostPlatform(conn)).rejects.toMatchObject({
      cause: expect.objectContaining({ reason: 2 })
    })
    // Both probes run: the second gets a fresh session-channel retry budget.
    expect(execCommandMock).toHaveBeenCalledTimes(4)
  })

  it('still detects Windows when the uname probe hits the session limit', async () => {
    execCommandMock
      .mockRejectedValueOnce(maxSessionsError())
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Windows AMD64\r\n')

    await expect(detectRemoteHostPlatform(conn)).resolves.toMatchObject({
      relayPlatform: 'win32-x64'
    })
  })

  it('skips the second probe when the first channel never confirmed close', async () => {
    const error = Object.assign(new Error('boom'), { sshChannelCloseConfirmed: false })
    execCommandMock.mockRejectedValueOnce(error)

    await expect(detectRemoteHostPlatform(conn)).rejects.toBe(error)
    expect(execCommandMock).toHaveBeenCalledTimes(1)
  })

  it('skips the second probe when the first was cancelled', async () => {
    const error = Object.assign(new Error('SSH operation was cancelled'), { name: 'AbortError' })
    execCommandMock.mockRejectedValueOnce(error)

    await expect(detectRemoteHostPlatform(conn)).rejects.toBe(error)
    expect(execCommandMock).toHaveBeenCalledTimes(1)
  })

  it('prefers a refused channel over the other probe non-zero exit', async () => {
    execCommandMock
      .mockRejectedValueOnce(new Error('Command "sh -c ..." failed (exit 127): sh: not found'))
      .mockRejectedValueOnce(maxSessionsError())

    await expect(detectRemoteHostPlatform(conn)).rejects.toThrow(/open failed/u)
    await expect(detectRemoteHostPlatform(conn)).rejects.not.toThrow(/exit 127/u)
  })

  it('prefers unrecognized uname output over a failed PowerShell probe', async () => {
    execCommandMock
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux')
      .mockRejectedValueOnce(new Error('powershell.exe: not found'))

    await expect(detectRemoteHostPlatform(conn)).rejects.toThrow(/__ORCA_REMOTE_PLATFORM__ Linux/u)
  })

  it('reports the raw probe output when a POSIX host yields no marker line', async () => {
    // Restricted shell / ForceCommand: the probe command is swallowed, banner only.
    execCommandMock.mockResolvedValue('Welcome to pc-server05\n')

    await expect(detectRemoteHostPlatform(conn)).rejects.toThrow(/pc-server05/u)
  })

  it('truncates a long banner in the thrown message but logs a longer tail', async () => {
    execCommandMock.mockResolvedValue(`${'banner line\n'.repeat(500)}goodbye\n`)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const error = await detectRemoteHostPlatform(conn).catch((err: Error) => err)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain('\n')
    expect((error as Error).message.length).toBeLessThanOrEqual(300)
    expect(String(warnSpy.mock.calls[0]?.[0]).length).toBeGreaterThan(600)
  })

  it('returns null when a parsed uname is genuinely unsupported', async () => {
    execCommandMock
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ FreeBSD x86_64\n')
      .mockRejectedValueOnce(new Error('powershell.exe: not found'))

    await expect(detectRemoteHostPlatform(conn)).resolves.toBeNull()
  })

  it('does not call an unmappable uname unsupported when PowerShell was refused', async () => {
    // Cygwin sh on a win32-x64 host: only PowerShell can settle it, and it never ran.
    execCommandMock
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ CYGWIN_NT-10.0 x86_64\n')
      .mockRejectedValueOnce(maxSessionsError())

    const error = await detectRemoteHostPlatform(conn).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/open failed/iu)
    expect((error as Error).message).not.toMatch(/unsupported/iu)
    expect((error as Error).cause).toMatchObject({ reason: 2 })
  })

  it('does not call an unmappable uname unsupported when the PowerShell probe timed out', async () => {
    // The timed-out channel is the better explanation, and it is identified by execCommand's typed
    // code — matching "timed out after Ns" in the message let any look-alike claim the branch.
    execCommandMock
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ CYGWIN_NT-10.0 x86_64\n')
      .mockRejectedValueOnce(
        Object.assign(new Error('Command "pwsh" timed out after 30s'), {
          code: SSH_EXEC_TIMEOUT_CODE
        })
      )

    const error = await detectRemoteHostPlatform(conn).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toMatch(/unsupported/iu)
    expect((error as Error).cause).toMatchObject({ code: SSH_EXEC_TIMEOUT_CODE })
  })

  it('does not read a look-alike timeout message as a timed-out channel', async () => {
    execCommandMock
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ FreeBSD x86_64\n')
      .mockRejectedValueOnce(new Error('the agent it launched timed out after 30s'))

    await expect(detectRemoteHostPlatform(conn)).resolves.toBeNull()
  })

  it('falls through to PowerShell for a Cygwin uname it cannot map', async () => {
    execCommandMock
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ CYGWIN_NT-10.0 x86_64\n')
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Windows AMD64\r\n')

    await expect(detectRemoteHostPlatform(conn)).resolves.toMatchObject({
      relayPlatform: 'win32-x64'
    })
  })
})
