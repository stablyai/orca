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

// Recover the PowerShell script from a `powershell.exe ... -EncodedCommand <b64>`
// command so tests can assert on the actual (UTF-16LE) payload sent to the host.
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
      entries: [
        { name: 'src', isDirectory: true },
        { name: 'notes file.txt', isDirectory: false },
        { name: 'README.md', isDirectory: false }
      ]
    })
    expect(exec).toHaveBeenCalledWith('cd "$HOME" && pwd && command ls -1Ap')
    expect(channel.listenerCount('data')).toBe(0)
    expect(channel.listenerCount('exit')).toBe(0)
    expect(channel.listenerCount('close')).toBe(0)
    expect(channel.listenerCount('error')).toBe(0)
    expect(channel.stderr.listenerCount('data')).toBe(0)
    expect(channel.stderr.listenerCount('error')).toBe(0)
  })

  it('escapes remote browse paths before invoking command ls', async () => {
    const channel = createMockChannel()
    const exec = vi.fn().mockResolvedValue(channel)
    const getConnectionManager = () => ({
      getConnection: () => ({ exec })
    })
    registerSshBrowseHandler(getConnectionManager as never)

    const resultPromise = handler(null, { targetId: 'ssh-1', dirPath: "/tmp/it's here" })
    await Promise.resolve()
    channel.emit('data', Buffer.from("/tmp/it's here\n"))
    channel.emit('exit', 0)
    channel.emit('close')

    await expect(resultPromise).resolves.toEqual({
      resolvedPath: "/tmp/it's here",
      entries: []
    })
    expect(exec).toHaveBeenCalledWith("cd '/tmp/it'\\''s here' && pwd && command ls -1Ap")
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
    // Windows OpenSSH exec emits CRLF; the parser must strip \r so directories
    // aren't misclassified as files with a stray carriage return in the name.
    // The script emits a forward-slash resolvedPath (the -replace '\\','/' line)
    // so the renderer's parentPath/joinPath, which only split on `/`, still work.
    windowsChannel.emit('data', Buffer.from('C:/Users/alice\r\nDesktop/\r\nnotes.txt\r\n'))
    windowsChannel.emit('exit', 0)
    windowsChannel.emit('close')

    await expect(resultPromise).resolves.toEqual({
      resolvedPath: 'C:/Users/alice',
      entries: [
        { name: 'Desktop', isDirectory: true },
        { name: 'notes.txt', isDirectory: false }
      ]
    })
    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec).toHaveBeenNthCalledWith(1, "cd 'C:/Users/alice' && pwd && command ls -1Ap")
    expect(exec.mock.calls[1]?.[0]).toMatch(/^powershell\.exe /)
    expect(exec.mock.calls[1]?.[1]).toEqual({ wrapCommand: false })

    // Decode the -EncodedCommand payload so an accidental switch from the
    // single-quote-escaped PowerShell literal to raw interpolation (an injection
    // regression) is caught, and to lock in the UTF-8 output pin.
    const script = decodeEncodedCommand(exec.mock.calls[1]?.[0] ?? '')
    expect(script).toContain('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8')
    expect(script).toContain("$dir = 'C:/Users/alice'")
    expect(script).toContain('Get-ChildItem -LiteralPath $resolved -Force')
    // resolvedPath must be emitted with forward slashes so the renderer's
    // parentPath/joinPath (which only split on `/`) keep working on Windows.
    expect(script).toContain("Write-Output ($resolved -replace '\\\\', '/')")
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
    // cmd.exe returns ERRORLEVEL 9009 for an unrecognized command in every locale;
    // the fallback must trigger off that even when stderr text isn't English/Spanish.
    posixChannel.stderr.emit('data', Buffer.from('Der Befehl "exec" ist falsch geschrieben'))
    posixChannel.emit('exit', 9009)
    posixChannel.emit('close')
    await vi.waitFor(() => {
      expect(windowsChannel.listenerCount('close')).toBe(1)
    })
    windowsChannel.emit('data', Buffer.from("C:/O'Brien\r\n"))
    windowsChannel.emit('exit', 0)
    windowsChannel.emit('close')

    await expect(resultPromise).resolves.toEqual({
      resolvedPath: "C:/O'Brien",
      entries: []
    })
    const script = decodeEncodedCommand(exec.mock.calls[1]?.[0] ?? '')
    // Single quote must be doubled inside the PowerShell literal, not passed raw.
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
    posixChannel.emit('exit', 9009)
    posixChannel.emit('close')
    await vi.waitFor(() => {
      expect(windowsChannel.listenerCount('close')).toBe(1)
    })
    windowsChannel.emit('data', Buffer.from('C:/Users/alice\r\n'))
    windowsChannel.emit('exit', 0)
    windowsChannel.emit('close')

    await expect(resultPromise).resolves.toEqual({ resolvedPath: 'C:/Users/alice', entries: [] })
    const script = decodeEncodedCommand(exec.mock.calls[1]?.[0] ?? '')
    // ~ must expand to $HOME, not be passed literally to Set-Location.
    expect(script).toContain('$dir = $HOME')
  })

  it('does not retry with PowerShell for an ordinary POSIX browse failure', async () => {
    const channel = createMockChannel()
    const exec = vi.fn().mockResolvedValue(channel)
    const getConnectionManager = () => ({
      getConnection: () => ({ exec })
    })
    registerSshBrowseHandler(getConnectionManager as never)

    const resultPromise = handler(null, { targetId: 'ssh-1', dirPath: '/root/secret' })
    await Promise.resolve()
    channel.stderr.emit('data', Buffer.from('ls: /root/secret: Permission denied'))
    channel.emit('exit', 1)
    channel.emit('close')

    await expect(resultPromise).rejects.toThrow('Permission denied')
    // A permission failure must surface directly — no masking PowerShell retry.
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('surfaces the PowerShell error when a 9009 Windows fallback also fails', async () => {
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
    posixChannel.emit('exit', 9009)
    posixChannel.emit('close')
    await vi.waitFor(() => {
      expect(windowsChannel.listenerCount('close')).toBe(1)
    })
    windowsChannel.stderr.emit('data', Buffer.from('Cannot find path C:/missing'))
    windowsChannel.emit('exit', 1)
    windowsChannel.emit('close')

    // 9009 proves the host is Windows, so PowerShell's error is the real cause —
    // surface it rather than the cmd.exe "exec is not recognized" prose.
    await expect(resultPromise).rejects.toThrow('Cannot find path')
  })

  it('surfaces the original POSIX error when a heuristic-matched fallback also fails', async () => {
    const posixChannel = createMockChannel()
    const windowsChannel = createMockChannel()
    const exec = vi.fn().mockResolvedValueOnce(posixChannel).mockResolvedValueOnce(windowsChannel)
    const getConnectionManager = () => ({
      getConnection: () => ({ exec })
    })
    registerSshBrowseHandler(getConnectionManager as never)

    const resultPromise = handler(null, { targetId: 'ssh-1', dirPath: '/opt/exec' })
    await Promise.resolve()
    // A POSIX error that merely mentions exec/not found matches the string
    // heuristic (exit code is a plain non-9009), so the fallback is a false start.
    posixChannel.stderr.emit('data', Buffer.from('exec: command not found'))
    posixChannel.emit('exit', 127)
    posixChannel.emit('close')
    await vi.waitFor(() => {
      expect(windowsChannel.listenerCount('close')).toBe(1)
    })
    windowsChannel.stderr.emit('data', Buffer.from('sh: powershell.exe: not found'))
    windowsChannel.emit('exit', 127)
    windowsChannel.emit('close')

    // The original POSIX failure is the real one — don't mask it with the
    // misleading "powershell.exe: not found" from the doomed retry.
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
