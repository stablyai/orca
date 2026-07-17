import { spawnSync } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'

const execCommandMock = vi.hoisted(() => vi.fn())

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: execCommandMock
}))

const { detectSshRelayWindowsCompatibility } =
  await import('./ssh-relay-windows-compatibility-detection')

const conn = {} as SshConnection
const marker = '__ORCA_SSH_RELAY_WINDOWS_COMPATIBILITY__'

function segment(
  fields: string[] = [
    'build=19045',
    'openSshVersion=8.1p1',
    'powerShellVersion=5.1.19041.5608',
    'dotNetFrameworkRelease=528040'
  ]
): string {
  return [`${marker} BEGIN`, ...fields, `${marker} END`].join('\n')
}

function decodePowerShellCommand(command: string): { encoded: string; script: string } {
  const encoded = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/)?.[1]
  if (!encoded) {
    throw new Error('missing encoded PowerShell command')
  }
  return { encoded, script: Buffer.from(encoded, 'base64').toString('utf16le') }
}

function isExpectedPowerShellStartupStderr(stderr: string): boolean {
  if (stderr === '') {
    return true
  }
  // Why: hosted Windows emits bounded first-use progress CLIXML before the encoded script starts.
  return (
    stderr.length <= 4096 &&
    stderr.startsWith('#< CLIXML') &&
    stderr.includes('S="progress"') &&
    stderr.includes('Preparing modules for first use.') &&
    !stderr.includes('S="Error"')
  )
}

describe('detectSshRelayWindowsCompatibility', () => {
  beforeEach(() => {
    execCommandMock.mockReset()
  })

  it.each([
    {
      label: 'Windows 10 x64 floor',
      output: segment(),
      expected: {
        build: 19045,
        openSshVersion: '8.1p1',
        powerShellVersion: '5.1.19041.5608',
        dotNetFrameworkRelease: 528040
      }
    },
    {
      label: 'Windows Server 2022 x64',
      output: segment([
        'dotNetFrameworkRelease=528449',
        'powerShellVersion=5.1.20348.2849',
        'openSshVersion=9.5p1',
        'build=20348'
      ]),
      expected: {
        build: 20348,
        openSshVersion: '9.5p1',
        powerShellVersion: '5.1.20348.2849',
        dotNetFrameworkRelease: 528449
      }
    },
    {
      label: 'Windows 11 arm64 floor',
      output: segment([
        'build=26100',
        'openSshVersion=9.5p1',
        'powerShellVersion=5.1.26100.2161',
        'dotNetFrameworkRelease=533320'
      ]),
      expected: {
        build: 26100,
        openSshVersion: '9.5p1',
        powerShellVersion: '5.1.26100.2161',
        dotNetFrameworkRelease: 533320
      }
    }
  ])('returns complete strict evidence for $label', async ({ output, expected }) => {
    execCommandMock.mockResolvedValueOnce(`startup noise\n${output}\ntrailing noise`)

    await expect(detectSshRelayWindowsCompatibility(conn)).resolves.toEqual(expected)
  })

  it.each([
    ['', 'empty output'],
    [`build=19045\nopenSshVersion=8.1p1`, 'unmarked fields'],
    [`${marker} BEGIN\nbuild=19045`, 'unterminated segment'],
    [segment().replace(`${marker} END`, ''), 'missing end marker'],
    [segment().replace('build=19045\n', ''), 'missing field'],
    [segment().replace('build=19045', 'build='), 'empty field'],
    [segment().replace('build=19045', 'build=19045\nbuild=20348'), 'duplicate field'],
    [segment().replace('build=19045', 'futureField=1'), 'unknown field'],
    [segment().replace('build=19045', 'build=19.045'), 'malformed build'],
    [segment().replace('build=19045', 'build=9007199254740992'), 'unsafe build integer'],
    [segment().replace('openSshVersion=8.1p1', 'openSshVersion=OpenSSH_8.1p1'), 'noisy SSH'],
    [segment().replace('openSshVersion=8.1p1', 'openSshVersion=8.1'), 'malformed SSH'],
    [segment().replace('powerShellVersion=5.1.19041.5608', 'powerShellVersion=5'), 'short PS'],
    [
      segment().replace('powerShellVersion=5.1.19041.5608', 'powerShellVersion=5.1.2.3.4'),
      'long PS'
    ],
    [
      segment().replace('dotNetFrameworkRelease=528040', 'dotNetFrameworkRelease=-1'),
      'negative .NET release'
    ],
    [segment(Array.from({ length: 5 }, (_, index) => `unknown${index}=1`)), 'too many lines'],
    [segment().replace('build=19045', `build=${'1'.repeat(129)}`), 'oversized line'],
    [`${segment()}\n${segment()}`, 'duplicate segment'],
    [`${marker} BEGIN\n${segment()}\n${marker} END`, 'nested segment'],
    [`startup${marker} BEGIN\n${segment().split('\n').slice(1).join('\n')}`, 'joined marker']
  ])('returns unknown for %s', async (output) => {
    execCommandMock.mockResolvedValueOnce(output)

    await expect(detectSshRelayWindowsCompatibility(conn)).resolves.toBeUndefined()
  })

  it('classifies an unavailable probe as unknown', async () => {
    execCommandMock.mockRejectedValueOnce(new Error('remote PowerShell unavailable'))

    await expect(detectSshRelayWindowsCompatibility(conn)).resolves.toBeUndefined()
  })

  it('propagates cancellation through one signal-qualified bounded probe', async () => {
    const signal = new AbortController().signal
    const abortError = Object.assign(new Error('cancelled'), { name: 'AbortError' })
    execCommandMock.mockRejectedValueOnce(abortError)

    await expect(detectSshRelayWindowsCompatibility(conn, { signal })).rejects.toBe(abortError)
    expect(execCommandMock).toHaveBeenCalledTimes(1)
    expect(execCommandMock).toHaveBeenCalledWith(conn, expect.any(String), {
      signal,
      timeoutMs: 15_000,
      wrapCommand: false
    })
  })

  it('constructs one encoded noninteractive probe with bounded native-only acquisition', async () => {
    execCommandMock.mockResolvedValueOnce(segment())

    await detectSshRelayWindowsCompatibility(conn)

    const command = execCommandMock.mock.calls[0]?.[1] ?? ''
    expect(command).toMatch(
      /^powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand /u
    )
    const { script } = decodePowerShellCommand(command)
    expect(script).toContain('[Microsoft.Win32.RegistryView]::Registry64')
    expect(script).toContain('CurrentBuildNumber')
    expect(script).toContain('NDP\\v4\\Full')
    expect(script).toContain("Get-Command -Name 'sshd.exe' -CommandType Application")
    expect(script).toContain('& $sshdPath -V')
    expect(script).toContain('Select-Object -First 8')
    expect(script).toContain('$versionOutput.Length -le 4096')
    expect(script).toContain('$matches.Count -eq 1')
    expect(script).toContain('$PSVersionTable.PSVersion')
    expect(script).toContain(`${marker} BEGIN`)
    expect(script).toContain(`${marker} END`)
    expect(script).not.toMatch(
      /\b(?:node|npm|python|perl|tar|sha256sum|shasum|git|github|invoke-webrequest|curl)\b/iu
    )
  })

  it.each([
    { label: 'empty', stderr: '', expected: true },
    {
      label: 'bounded first-use progress',
      stderr:
        '#< CLIXML\r\n<Objs><Obj S="progress"><AV>Preparing modules for first use.</AV></Obj></Objs>',
      expected: true
    },
    { label: 'unknown', stderr: 'unexpected stderr', expected: false },
    {
      label: 'error CLIXML',
      stderr:
        '#< CLIXML\r\n<Objs><Obj S="progress"><AV>Preparing modules for first use.</AV></Obj><Obj S="Error" /></Objs>',
      expected: false
    },
    {
      label: 'oversized progress',
      stderr: `#< CLIXML\r\n<Obj S="progress">Preparing modules for first use.${'x'.repeat(4096)}`,
      expected: false
    }
  ])('classifies $label PowerShell startup stderr', ({ stderr, expected }) => {
    expect(isExpectedPowerShellStartupStderr(stderr)).toBe(expected)
  })

  it.runIf(process.platform === 'win32')(
    'executes the encoded probe under native Windows PowerShell with bounded marker output',
    async () => {
      execCommandMock.mockResolvedValueOnce(segment())
      await detectSshRelayWindowsCompatibility(conn)
      const { encoded } = decodePowerShellCommand(execCommandMock.mock.calls[0]?.[1] ?? '')

      const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { encoding: 'utf8', timeout: 15_000 }
      )

      expect({
        status: result.status,
        error: result.error,
        expectedStartupStderr: isExpectedPowerShellStartupStderr(result.stderr)
      }).toEqual({
        status: 0,
        error: undefined,
        expectedStartupStderr: true
      })
      const outputLines = result.stdout.split(/\r?\n/u).filter(Boolean)
      expect(outputLines[0]).toBe(`${marker} BEGIN`)
      expect(outputLines.at(-1)).toBe(`${marker} END`)
      expect(outputLines).toHaveLength(6)
      expect(outputLines.every((line) => line.length <= 128)).toBe(true)
    }
  )
})
