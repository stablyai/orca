import { describe, expect, it, vi } from 'vitest'
import { makeMockConnection } from './ssh-relay-deploy-test-fixture'
import { existsSync, readFileSync } from 'node:fs'
import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand, waitForSentinel } from './ssh-relay-deploy-helpers'
import { resolveRemoteNodePath } from './ssh-remote-node-resolution'

function decodePowerShellCommand(command: string): string | null {
  const match = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/)
  return match ? Buffer.from(match[1], 'base64').toString('utf16le') : null
}

const extractWindowsSockPath = (script: string): string =>
  /--sock-path\s+'([^']+)'/.exec(script)?.[1] ?? ''

const extractWindowsMarkerPath = (script: string): string =>
  /-LiteralPath\s+'([^']*\.windows-active-pipe[^']*)'/.exec(script)?.[1] ?? ''

describe('deployAndLaunchRelay on Windows', () => {
  it('uses bundled Bun for Windows probes and launch without host Node', async () => {
    const conn = makeMockConnection()
    vi.mocked(readFileSync).mockImplementation((path) =>
      String(path).endsWith('.bun-required') ? 'bun\n' : '0.1.0+abcdef012345'
    )
    vi.mocked(existsSync).mockImplementation((path) => {
      const pathname = String(path)
      if (pathname.endsWith('bun-runtime')) {
        return true
      }
      return !/bun-runtime(?:-|$)/u.test(pathname)
    })
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Windows AMD64')
    mockExecCommand.mockResolvedValueOnce('C:/Users/me user')
    mockExecCommand.mockResolvedValueOnce('READY') // strict Bun runtime verification
    mockExecCommand.mockResolvedValueOnce('') // strict Bun runtime verification
    mockExecCommand.mockResolvedValueOnce('') // active-pipe marker
    mockExecCommand.mockResolvedValueOnce('WAITING') // existing pipe probe
    mockExecCommand.mockResolvedValueOnce('') // credential write
    mockExecCommand.mockResolvedValueOnce('READY') // launch wait

    const result = await deployAndLaunchRelay(conn)

    expect(result.runtimeKind).toBe('bun')
    expect(result.runtimePath).toContain('bun-runtime')
    expect(result.nodePath).toBeUndefined()
    expect(resolveRemoteNodePath).not.toHaveBeenCalled()
    const commands = [
      ...mockExecCommand.mock.calls.map(([command]) => command),
      ...vi.mocked(conn.exec).mock.calls.map(([command]) => command)
    ]
      .filter((command): command is string => typeof command === 'string')
      .map((command) => decodePowerShellCommand(command) ?? command)
    expect(commands.some((command) => command.includes('bun-runtime'))).toBe(true)
    expect(commands.some((command) => /\bnpm\b/u.test(command))).toBe(false)
    expect(commands.some((command) => /(?:^|[^A-Za-z])node(?:[^A-Za-z]|$)/u.test(command))).toBe(
      false
    )
  })

  it('launches Windows remotes via a named pipe endpoint', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    vi.mocked(resolveRemoteNodePath).mockResolvedValue('C:/Program Files/nodejs/node.exe')
    mockExecCommand
      .mockRejectedValueOnce(new Error('uname not found')) // tagged POSIX platform probe
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Windows X64') // tagged PowerShell platform probe
      .mockResolvedValueOnce('C:\\Users\\me user') // remote home
      .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK') // native deps probe
      .mockResolvedValueOnce('') // no persisted active pipe
      .mockResolvedValueOnce('WAITING') // named pipe probe
      .mockResolvedValueOnce('') // WMI relay launch
      .mockResolvedValueOnce('READY') // named pipe poll
      .mockResolvedValueOnce('') // persist active pipe marker

    const result = await deployAndLaunchRelay(conn, undefined, 300, 'target-a')

    expect(result.platform).toBe('win32-x64')
    expect(result.remoteHome).toBe('C:/Users/me user')
    expect(result.sockPath).toMatch(/^\\\\\.\\pipe\\orca-relay-[0-9a-f]{20}$/)
    const execCommands = vi.mocked(conn.exec).mock.calls.map(([cmd]) => cmd as string)
    expect(execCommands).toHaveLength(1)
    expect(execCommands[0]).toContain('powershell.exe')
    const decodedScripts = mockExecCommand.mock.calls
      .map(([, command]) => decodePowerShellCommand(command))
      .filter((script): script is string => script !== null)
    const launchScript = decodedScripts.find((script) => script.includes('Invoke-CimMethod')) ?? ''
    expect(launchScript).toContain(
      '"C:/Users/me user/.orca-remote/relay-0.1.0+abcdef012345/relay.js"'
    )
    expect(launchScript).toContain(
      '"C:/Users/me user/.orca-remote/relay-0.1.0+abcdef012345/agent-hooks/orca-relay-'
    )
    expect(launchScript).toContain('--endpoint-dir')
    expect(launchScript).not.toContain('--pty-source-credit-v1')
    expect(launchScript).not.toContain('.pty-source-credit-policy')
    expect(launchScript).not.toContain('--enable-ownership-transfer-mutation')
    expect(launchScript).not.toContain('--enable-delegated-ownership-capture')
    expect(launchScript).not.toContain('--enable-source-delivery-retirement')
    expect(launchScript).not.toContain('\\\\.\\pipe\\agent-hooks')
    const waitScript = decodedScripts.find((script) => script.includes('deadline=Date.now()')) ?? ''
    expect(waitScript).toContain('setTimeout(attempt,intervalMs)')
    const windowsLaunchCalls = mockExecCommand.mock.calls.filter(([, command]) => {
      const script = decodePowerShellCommand(command)
      return (
        script?.includes('.windows-active-pipe') ||
        script?.includes('Invoke-CimMethod') ||
        script?.includes('deadline=Date.now()')
      )
    })
    expect(windowsLaunchCalls.length).toBeGreaterThan(0)
    expect(
      windowsLaunchCalls.every(([, , options]) => options?.signal instanceof AbortSignal)
    ).toBe(true)
    expect(vi.mocked(conn.exec).mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(vi.mocked(waitForSentinel).mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal)
  })

  it('adds the ownership-transfer mutation flag to an opted-in Windows launch', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    vi.mocked(resolveRemoteNodePath).mockResolvedValue('C:/Program Files/nodejs/node.exe')
    mockExecCommand
      .mockRejectedValueOnce(new Error('uname not found'))
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Windows X64')
      .mockResolvedValueOnce('C:\\Users\\me user')
      .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('WAITING')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('READY')
      .mockResolvedValueOnce('')

    await deployAndLaunchRelay(conn, undefined, 300, 'target-a', {
      enableOwnershipTransferMutation: true
    })

    const decodedScripts = mockExecCommand.mock.calls
      .map(([, command]) => decodePowerShellCommand(command))
      .filter((script): script is string => script !== null)
    const launchScript = decodedScripts.find((script) => script.includes('Invoke-CimMethod')) ?? ''
    expect(launchScript).toContain('--enable-ownership-transfer-mutation')
    expect(launchScript).toContain('--enable-delegated-ownership-capture')
    expect(launchScript).toContain('--enable-source-delivery-retirement')
  })

  it('relaunches Windows remotes on a fallback pipe when reconnecting the occupied pipe fails', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    vi.mocked(resolveRemoteNodePath).mockResolvedValue('C:/Program Files/nodejs/node.exe')
    vi.mocked(waitForSentinel)
      .mockRejectedValueOnce(new Error('stale daemon handshake failed'))
      .mockResolvedValueOnce({
        write: vi.fn(),
        onData: vi.fn(),
        onClose: vi.fn()
      })
    mockExecCommand
      .mockRejectedValueOnce(new Error('uname not found')) // tagged POSIX platform probe
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Windows X64') // tagged PowerShell platform probe
      .mockResolvedValueOnce('C:\\Users\\me user') // remote home
      .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK') // native deps probe
      .mockResolvedValueOnce('') // no persisted active pipe yet
      .mockResolvedValueOnce('READY') // existing named pipe probe
      .mockResolvedValueOnce('WAITING') // deterministic fallback pipe is not already running
      .mockResolvedValueOnce('') // WMI relay launch on fallback pipe
      .mockResolvedValueOnce('READY') // fallback pipe poll
      .mockResolvedValueOnce('') // persist fallback active pipe marker

    const result = await deployAndLaunchRelay(conn, undefined, 300, 'target-a')

    const execCommands = vi.mocked(conn.exec).mock.calls.map(([cmd]) => cmd as string)
    expect(execCommands).toHaveLength(2)
    const firstConnectScript = decodePowerShellCommand(execCommands[0]) ?? ''
    const secondConnectScript = decodePowerShellCommand(execCommands[1]) ?? ''
    const primaryPipe = extractWindowsSockPath(firstConnectScript)
    const fallbackPipe = extractWindowsSockPath(secondConnectScript)
    expect(primaryPipe).toMatch(/^\\\\\.\\pipe\\orca-relay-[0-9a-f]{20}$/)
    expect(fallbackPipe).toMatch(/^\\\\\.\\pipe\\orca-relay-[0-9a-f]{20}$/)
    expect(fallbackPipe).not.toBe(primaryPipe)
    expect(result.sockPath).toBe(fallbackPipe)

    const launchScript =
      mockExecCommand.mock.calls
        .map(([, command]) => decodePowerShellCommand(command))
        .find((script) => script?.includes('Invoke-CimMethod')) ?? ''
    expect(launchScript).toContain(fallbackPipe)
    expect(launchScript).not.toContain(primaryPipe)

    const markerWriteScript =
      mockExecCommand.mock.calls
        .map(([, command]) => decodePowerShellCommand(command))
        .find(
          (script) => script?.includes('Set-Content') && script.includes('.windows-active-pipe')
        ) ?? ''
    expect(markerWriteScript).toContain(fallbackPipe)
    expect(markerWriteScript).not.toContain(primaryPipe)
  })

  it('prefers a persisted Windows fallback pipe on later reconnects', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    const persistedPipe = '\\\\.\\pipe\\orca-relay-1234567890abcdef1234'
    vi.mocked(resolveRemoteNodePath).mockResolvedValue('C:/Program Files/nodejs/node.exe')
    mockExecCommand
      .mockRejectedValueOnce(new Error('uname not found')) // tagged POSIX platform probe
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Windows X64') // tagged PowerShell platform probe
      .mockResolvedValueOnce('C:\\Users\\me user') // remote home
      .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK') // native deps probe
      .mockResolvedValueOnce(`${persistedPipe}\n`) // persisted active pipe marker
      .mockResolvedValueOnce('READY') // persisted named pipe probe
      .mockResolvedValueOnce('') // refresh active pipe marker

    const result = await deployAndLaunchRelay(conn, undefined, 300, 'target-a')

    const execCommands = vi.mocked(conn.exec).mock.calls.map(([cmd]) => cmd as string)
    expect(execCommands).toHaveLength(1)
    const connectScript = decodePowerShellCommand(execCommands[0]) ?? ''
    expect(extractWindowsSockPath(connectScript)).toBe(persistedPipe)
    expect(result.sockPath).toBe(persistedPipe)

    const decodedExecScripts = mockExecCommand.mock.calls
      .map(([, command]) => decodePowerShellCommand(command))
      .filter((script): script is string => script !== null)
    expect(decodedExecScripts.some((script) => script.includes('Invoke-CimMethod'))).toBe(false)
  })

  it('scopes persisted Windows active pipe markers by relay target', async () => {
    const connA = makeMockConnection()
    const connB = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    vi.mocked(resolveRemoteNodePath).mockResolvedValue('C:/Program Files/nodejs/node.exe')
    mockExecCommand
      .mockRejectedValueOnce(new Error('uname not found')) // tagged POSIX platform probe A
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Windows X64')
      .mockResolvedValueOnce('C:\\Users\\me user')
      .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
      .mockResolvedValueOnce('') // no persisted active pipe A
      .mockResolvedValueOnce('WAITING')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('READY')
      .mockResolvedValueOnce('') // persist active pipe A
      .mockRejectedValueOnce(new Error('uname not found')) // tagged POSIX platform probe B
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Windows X64')
      .mockResolvedValueOnce('C:\\Users\\me user')
      .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
      .mockResolvedValueOnce('') // no persisted active pipe B
      .mockResolvedValueOnce('WAITING')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('READY')
      .mockResolvedValueOnce('') // persist active pipe B

    await deployAndLaunchRelay(connA, undefined, 300, 'target-a')
    await deployAndLaunchRelay(connB, undefined, 300, 'target-b')

    const markerPaths = mockExecCommand.mock.calls
      .map(([, command]) => decodePowerShellCommand(command))
      .filter((script): script is string => Boolean(script?.includes('Get-Content')))
      .map(extractWindowsMarkerPath)

    expect(markerPaths).toHaveLength(2)
    expect(markerPaths[0]).toContain('.windows-active-pipe-relay-')
    expect(markerPaths[1]).toContain('.windows-active-pipe-relay-')
    expect(markerPaths[0]).not.toBe(markerPaths[1])
  })
})
