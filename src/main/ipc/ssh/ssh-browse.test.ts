import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerSshBrowseHandler } from './ssh-browse'

const { handleMock, removeHandlerMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
    removeHandler: removeHandlerMock
  }
}))

type BrowseHandler = (
  event: unknown,
  args: { targetId: string; dirPath: string }
) => Promise<unknown>

function createMockChannel(): EventEmitter & { stderr: EventEmitter } {
  return Object.assign(new EventEmitter(), {
    stderr: new EventEmitter()
  })
}

function decodeEncodedCommand(command: string): string {
  const match = /-EncodedCommand (\S+)/.exec(command)
  if (!match) {
    throw new Error(`no -EncodedCommand in: ${command}`)
  }
  return Buffer.from(match[1], 'base64').toString('utf16le')
}

describe('registerSshBrowseHandler', () => {
  let handler: BrowseHandler

  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    handleMock.mockImplementation((_channel: string, registeredHandler: BrowseHandler) => {
      handler = registeredHandler
    })
  })

  it('bypasses remote ls aliases when listing a directory', async () => {
    const channel = createMockChannel()
    const exec = vi.fn().mockResolvedValue(channel)
    const getConnectionManager = () => ({
      getConnection: () => ({ exec })
    })
    registerSshBrowseHandler(getConnectionManager as never)

    const resultPromise = handler(null, { targetId: 'ssh-1', dirPath: '~' })
    await Promise.resolve()
    channel.emit('data', Buffer.from('/home/user\nsrc/\nREADME.md\nnotes file.txt\n'))
    channel.emit('exit', 0)
    channel.emit('close')

    await expect(resultPromise).resolves.toEqual({
      resolvedPath: '/home/user',
      pathFlavor: 'posix',
      entries: [
        { name: 'src', isDirectory: true },
        { name: 'notes file.txt', isDirectory: false },
        { name: 'README.md', isDirectory: false }
      ]
    })
    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining('\ncd "$HOME" && pwd && entries=$(command ls -1A) && ')
    )
    expect(channel.listenerCount('data')).toBe(0)
    expect(channel.listenerCount('exit')).toBe(0)
    expect(channel.listenerCount('close')).toBe(0)
    expect(channel.listenerCount('error')).toBe(0)
    expect(channel.stderr.listenerCount('data')).toBe(0)
    expect(channel.stderr.listenerCount('error')).toBe(0)
  })

  it('reads the status from close when exit fired before the channel was returned', async () => {
    const channel = createMockChannel()
    // ssh2 can parse exit-status in the same chunk as the exec ack, before listeners attach.
    const exec = vi
      .fn()
      .mockImplementationOnce(async () => {
        channel.emit('exit', 0)
        return channel
      })
      .mockRejectedValue(new Error('unexpected PowerShell fallback'))
    const getConnectionManager = () => ({
      getConnection: () => ({ exec })
    })
    registerSshBrowseHandler(getConnectionManager as never)

    const resultPromise = handler(null, { targetId: 'ssh-1', dirPath: '~' })
    await Promise.resolve()
    channel.emit('data', Buffer.from('/home/user\nsrc/\n'))
    channel.emit('close', 0)

    await expect(resultPromise).resolves.toEqual({
      resolvedPath: '/home/user',
      pathFlavor: 'posix',
      entries: [{ name: 'src', isDirectory: true }]
    })
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('keeps an observed exit status over the close status', async () => {
    const channel = createMockChannel()
    const fallback = createMockChannel()
    const exec = vi
      .fn()
      .mockResolvedValueOnce(channel)
      .mockImplementationOnce(async () => {
        fallback.emit('exit', 127)
        return fallback
      })
    const getConnectionManager = () => ({
      getConnection: () => ({ exec })
    })
    registerSshBrowseHandler(getConnectionManager as never)

    const resultPromise = handler(null, { targetId: 'ssh-1', dirPath: '~' })
    const rejected = expect(resultPromise).rejects.toThrow('Remote listing failed (exit 7)')
    await Promise.resolve()
    channel.emit('data', Buffer.from('/home/user\n'))
    channel.emit('exit', 7)
    channel.emit('close', 0)
    await vi.waitFor(() => expect(fallback.listenerCount('close')).toBe(1))
    fallback.emit('close', 127)

    await rejected
  })

  it('escapes remote browse paths and reads the listing past rc-file stdout', async () => {
    const channel = createMockChannel()
    const exec = vi.fn().mockResolvedValue(channel)
    const getConnectionManager = () => ({
      getConnection: () => ({ exec })
    })
    registerSshBrowseHandler(getConnectionManager as never)

    const resultPromise = handler(null, { targetId: 'ssh-1', dirPath: "/tmp/it's here" })
    await Promise.resolve()
    // Login-shell rc output ahead of the fence must not become the resolved path.
    const command = String(exec.mock.calls[0]?.[0])
    const begin = (/__ORCA_SSH_CAPTURE_BEGIN_ \w+?__/.exec(command)?.[0] ?? '').replace(' ', '')
    const end = (/__ORCA_SSH_CAPTURE_END_ \w+?__/.exec(command)?.[0] ?? '').replace(' ', '')
    channel.emit('data', Buffer.from(`RC-BANNER stdout\n\u001b]0;t\u0007${begin}`))
    channel.emit('data', Buffer.from(`/tmp/it's here\n${end}`))
    channel.emit('exit', 0)
    channel.emit('close')

    await expect(resultPromise).resolves.toEqual({
      resolvedPath: "/tmp/it's here",
      pathFlavor: 'posix',
      entries: []
    })
    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining("\ncd '/tmp/it'\\''s here' && pwd && entries=$(command ls -1A) && ")
    )
  })

  it('falls back to PowerShell when a Windows SSH shell rejects POSIX exec', async () => {
    const posixChannel = createMockChannel()
    const windowsChannel = createMockChannel()
    const exec = vi.fn().mockResolvedValueOnce(posixChannel).mockResolvedValueOnce(windowsChannel)
    const getConnectionManager = () => ({
      getConnection: () => ({ exec })
    })
    registerSshBrowseHandler(getConnectionManager as never)

    const resultPromise = handler(null, { targetId: 'ssh-1', dirPath: 'C:/Users/alice' })
    await Promise.resolve()
    posixChannel.stderr.emit(
      'data',
      Buffer.from('"exec" no se reconoce como un comando interno o externo')
    )
    posixChannel.emit('exit', 1)
    posixChannel.emit('close')
    await vi.waitFor(() => {
      expect(windowsChannel.listenerCount('close')).toBe(1)
    })
    // Windows SSH emits CRLF; forward-slash paths preserve renderer parentPath/joinPath navigation.
    windowsChannel.emit('data', Buffer.from('C:/Users/alice\r\nDesktop/\r\nnotes.txt\r\n'))
    windowsChannel.emit('exit', 0)
    windowsChannel.emit('close')

    await expect(resultPromise).resolves.toEqual({
      resolvedPath: 'C:/Users/alice',
      pathFlavor: 'win32',
      entries: [
        { name: 'Desktop', isDirectory: true },
        { name: 'notes.txt', isDirectory: false }
      ]
    })
    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("\ncd 'C:/Users/alice' && pwd && entries=$(command ls -1A) && ")
    )
    expect(exec.mock.calls[1]?.[0]).toMatch(/^powershell\.exe /)
    expect(exec.mock.calls[1]?.[1]).toEqual({ wrapCommand: false })

    // Decode the payload to verify literal escaping and UTF-8 output.
    const script = decodeEncodedCommand(exec.mock.calls[1]?.[0] ?? '')
    expect(script).toContain('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8')
    expect(script).toContain("$dir = 'C:/Users/alice'")
    expect(script).toContain('Get-ChildItem -LiteralPath $resolved -Force')
    // Renderer path helpers require forward slashes.
    expect(script).toContain("Write-Output ($resolved -replace '\\\\', '/')")
  })

  it('lists Windows drive roots when an SSH picker browses the host root', async () => {
    const posixChannel = createMockChannel()
    const windowsChannel = createMockChannel()
    const exec = vi.fn().mockResolvedValueOnce(posixChannel).mockResolvedValueOnce(windowsChannel)
    const getConnectionManager = () => ({
      getConnection: () => ({ exec })
    })
    registerSshBrowseHandler(getConnectionManager as never)

    const resultPromise = handler(null, { targetId: 'ssh-1', dirPath: '/' })
    await Promise.resolve()
    posixChannel.stderr.emit('data', Buffer.from('"exec" is not recognized'))
    posixChannel.emit('exit', 1)
    posixChannel.emit('close')
    await vi.waitFor(() => {
      expect(windowsChannel.listenerCount('close')).toBe(1)
    })
    windowsChannel.emit('data', Buffer.from('/\r\nC:\\/\r\nM:\\/\r\n'))
    windowsChannel.emit('exit', 0)
    windowsChannel.emit('close')

    await expect(resultPromise).resolves.toEqual({
      resolvedPath: '/',
      pathFlavor: 'win32',
      entries: [
        { name: 'C:\\', isDirectory: true },
        { name: 'M:\\', isDirectory: true }
      ]
    })
    const script = decodeEncodedCommand(exec.mock.calls[1]?.[0] ?? '')
    expect(script).toContain('Get-PSDrive -PSProvider FileSystem')
    expect(script).not.toContain('Set-Location')
  })

  it('falls back for a non-English cmd.exe reject (exit 1, localized stderr)', async () => {
    // Windows SSH reports localized shell rejection with exit 1; fallback cannot depend on 9009 or English text.
    const posixChannel = createMockChannel()
    const windowsChannel = createMockChannel()
    const exec = vi.fn().mockResolvedValueOnce(posixChannel).mockResolvedValueOnce(windowsChannel)
    const getConnectionManager = () => ({
      getConnection: () => ({ exec })
    })
    registerSshBrowseHandler(getConnectionManager as never)

    const resultPromise = handler(null, { targetId: 'ssh-1', dirPath: 'C:/Users' })
    await Promise.resolve()
    // Japanese shell rejection must trigger fallback without English substring matching.
    posixChannel.stderr.emit(
      'data',
      Buffer.from("'exec' は、内部コマンドとして認識されていません。")
    )
    posixChannel.emit('exit', 1)
    posixChannel.emit('close')
    await vi.waitFor(() => {
      expect(windowsChannel.listenerCount('close')).toBe(1)
    })
    windowsChannel.emit('data', Buffer.from('C:/Users\r\nAdmin/\r\n'))
    windowsChannel.emit('exit', 0)
    windowsChannel.emit('close')

    await expect(resultPromise).resolves.toEqual({
      resolvedPath: 'C:/Users',
      pathFlavor: 'win32',
      entries: [{ name: 'Admin', isDirectory: true }]
    })
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('escapes single quotes in the PowerShell literal path', async () => {
    const posixChannel = createMockChannel()
    const windowsChannel = createMockChannel()
    const exec = vi.fn().mockResolvedValueOnce(posixChannel).mockResolvedValueOnce(windowsChannel)
    const getConnectionManager = () => ({
      getConnection: () => ({ exec })
    })
    registerSshBrowseHandler(getConnectionManager as never)

    const resultPromise = handler(null, { targetId: 'ssh-1', dirPath: "C:/O'Brien" })
    await Promise.resolve()
    // German shell rejection uses exit 1 over SSH; cmd's internal 9009 does not cross the boundary.
    posixChannel.stderr.emit('data', Buffer.from('Der Befehl "exec" ist falsch geschrieben'))
    posixChannel.emit('exit', 1)
    posixChannel.emit('close')
    await vi.waitFor(() => {
      expect(windowsChannel.listenerCount('close')).toBe(1)
    })
    windowsChannel.emit('data', Buffer.from("C:/O'Brien\r\n"))
    windowsChannel.emit('exit', 0)
    windowsChannel.emit('close')

    await expect(resultPromise).resolves.toEqual({
      resolvedPath: "C:/O'Brien",
      pathFlavor: 'win32',
      entries: []
    })
    const script = decodeEncodedCommand(exec.mock.calls[1]?.[0] ?? '')
    expect(script).toContain("$dir = 'C:/O''Brien'")
  })

  it('expands ~ to $HOME in the PowerShell fallback (the default browse path)', async () => {
    const posixChannel = createMockChannel()
    const windowsChannel = createMockChannel()
    const exec = vi.fn().mockResolvedValueOnce(posixChannel).mockResolvedValueOnce(windowsChannel)
    const getConnectionManager = () => ({
      getConnection: () => ({ exec })
    })
    registerSshBrowseHandler(getConnectionManager as never)

    const resultPromise = handler(null, { targetId: 'ssh-1', dirPath: '~' })
    await Promise.resolve()
    posixChannel.stderr.emit('data', Buffer.from('"exec" is not recognized'))
    posixChannel.emit('exit', 1)
    posixChannel.emit('close')
    await vi.waitFor(() => {
      expect(windowsChannel.listenerCount('close')).toBe(1)
    })
    windowsChannel.emit('data', Buffer.from('C:/Users/alice\r\n'))
    windowsChannel.emit('exit', 0)
    windowsChannel.emit('close')

    await expect(resultPromise).resolves.toEqual({
      resolvedPath: 'C:/Users/alice',
      entries: [],
      pathFlavor: 'win32'
    })
    const script = decodeEncodedCommand(exec.mock.calls[1]?.[0] ?? '')
    expect(script).toContain('$dir = $HOME')
  })

  // Renderer breadcrumbs can add a drive-leading slash or leave a bare drive; normalize both before Set-Location.
  it.each([
    { dirPath: '/C:/Users', expected: "$dir = 'C:/Users'" },
    { dirPath: 'C:', expected: "$dir = 'C:/'" },
    { dirPath: '/C:', expected: "$dir = 'C:/'" }
  ])(
    'roots the Windows drive path $dirPath in the PowerShell fallback',
    async ({ dirPath, expected }) => {
      const posixChannel = createMockChannel()
      const windowsChannel = createMockChannel()
      const exec = vi.fn().mockResolvedValueOnce(posixChannel).mockResolvedValueOnce(windowsChannel)
      const getConnectionManager = () => ({
        getConnection: () => ({ exec })
      })
      registerSshBrowseHandler(getConnectionManager as never)

      const resultPromise = handler(null, { targetId: 'ssh-1', dirPath })
      await Promise.resolve()
      posixChannel.stderr.emit('data', Buffer.from('"exec" is not recognized'))
      posixChannel.emit('exit', 1)
      posixChannel.emit('close')
      await vi.waitFor(() => {
        expect(windowsChannel.listenerCount('close')).toBe(1)
      })
      windowsChannel.emit('data', Buffer.from('C:/Users\r\n'))
      windowsChannel.emit('exit', 0)
      windowsChannel.emit('close')

      await expect(resultPromise).resolves.toEqual({
        resolvedPath: 'C:/Users',
        entries: [],
        pathFlavor: 'win32'
      })
      const script = decodeEncodedCommand(exec.mock.calls[1]?.[0] ?? '')
      expect(script).toContain(expected)
    }
  )

  it('surfaces the original POSIX failure when the PowerShell retry shows the host is not Windows', async () => {
    const posixChannel = createMockChannel()
    const windowsChannel = createMockChannel()
    const exec = vi.fn().mockResolvedValueOnce(posixChannel).mockResolvedValueOnce(windowsChannel)
    const getConnectionManager = () => ({
      getConnection: () => ({ exec })
    })
    registerSshBrowseHandler(getConnectionManager as never)

    const resultPromise = handler(null, { targetId: 'ssh-1', dirPath: '/root/secret' })
    await Promise.resolve()
    // POSIX permission failures also trigger the Windows probe.
    posixChannel.stderr.emit('data', Buffer.from('ls: /root/secret: Permission denied'))
    posixChannel.emit('exit', 1)
    posixChannel.emit('close')
    await vi.waitFor(() => {
      expect(windowsChannel.listenerCount('close')).toBe(1)
    })
    // Missing PowerShell proves the retry cannot replace the original POSIX error.
    windowsChannel.stderr.emit('data', Buffer.from('bash: powershell.exe: command not found'))
    windowsChannel.emit('exit', 127)
    windowsChannel.emit('close')

    await expect(resultPromise).rejects.toThrow('Permission denied')
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('surfaces the PowerShell error when the Windows fallback runs but fails', async () => {
    const posixChannel = createMockChannel()
    const windowsChannel = createMockChannel()
    const exec = vi.fn().mockResolvedValueOnce(posixChannel).mockResolvedValueOnce(windowsChannel)
    const getConnectionManager = () => ({
      getConnection: () => ({ exec })
    })
    registerSshBrowseHandler(getConnectionManager as never)

    const resultPromise = handler(null, { targetId: 'ssh-1', dirPath: 'C:/missing' })
    await Promise.resolve()
    posixChannel.stderr.emit('data', Buffer.from('"exec" is not recognized'))
    posixChannel.emit('exit', 1)
    posixChannel.emit('close')
    await vi.waitFor(() => {
      expect(windowsChannel.listenerCount('close')).toBe(1)
    })
    windowsChannel.stderr.emit('data', Buffer.from('Cannot find path C:/missing'))
    windowsChannel.emit('exit', 1)
    windowsChannel.emit('close')

    // A running PowerShell probe provides the authoritative Windows error.
    await expect(resultPromise).rejects.toThrow('Cannot find path')
  })

  it('surfaces the original POSIX error when the fallback shows powershell.exe is missing', async () => {
    const posixChannel = createMockChannel()
    const windowsChannel = createMockChannel()
    const exec = vi.fn().mockResolvedValueOnce(posixChannel).mockResolvedValueOnce(windowsChannel)
    const getConnectionManager = () => ({
      getConnection: () => ({ exec })
    })
    registerSshBrowseHandler(getConnectionManager as never)

    const resultPromise = handler(null, { targetId: 'ssh-1', dirPath: '/opt/exec' })
    await Promise.resolve()
    posixChannel.stderr.emit('data', Buffer.from('exec: command not found'))
    posixChannel.emit('exit', 127)
    posixChannel.emit('close')
    await vi.waitFor(() => {
      expect(windowsChannel.listenerCount('close')).toBe(1)
    })
    windowsChannel.stderr.emit('data', Buffer.from('sh: powershell.exe: not found'))
    windowsChannel.emit('exit', 127)
    windowsChannel.emit('close')

    await expect(resultPromise).rejects.toThrow('exec: command not found')
  })

  it('rejects and detaches listeners when the browse channel errors', async () => {
    const channel = createMockChannel()
    const exec = vi.fn().mockResolvedValue(channel)
    const getConnectionManager = () => ({
      getConnection: () => ({ exec })
    })
    registerSshBrowseHandler(getConnectionManager as never)

    const resultPromise = handler(null, { targetId: 'ssh-1', dirPath: '/tmp' })
    await Promise.resolve()
    channel.emit('error', new Error('remote disconnected'))

    await expect(resultPromise).rejects.toThrow('remote disconnected')
    expect(exec).toHaveBeenCalledTimes(1)
    expect(channel.listenerCount('data')).toBe(0)
    expect(channel.listenerCount('exit')).toBe(0)
    expect(channel.listenerCount('close')).toBe(0)
    expect(channel.listenerCount('error')).toBe(0)
    expect(channel.stderr.listenerCount('data')).toBe(0)
    expect(channel.stderr.listenerCount('error')).toBe(0)
  })

  it('times out browse channels that never close', async () => {
    vi.useFakeTimers()
    try {
      const channel = createMockChannel()
      const exec = vi.fn().mockResolvedValue(channel)
      const getConnectionManager = () => ({
        getConnection: () => ({ exec })
      })
      registerSshBrowseHandler(getConnectionManager as never)

      const resultPromise = handler(null, { targetId: 'ssh-1', dirPath: '/mnt/stalled' })
      let settled = false
      void resultPromise.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )

      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(15_000)

      expect(settled).toBe(true)
      await expect(resultPromise).rejects.toThrow('Remote directory listing timed out')
      expect(channel.listenerCount('data')).toBe(0)
      expect(channel.listenerCount('exit')).toBe(0)
      expect(channel.listenerCount('close')).toBe(0)
      expect(channel.listenerCount('error')).toBe(0)
      expect(channel.stderr.listenerCount('data')).toBe(0)
      expect(channel.stderr.listenerCount('error')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
