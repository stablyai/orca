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

  it('falls back for a non-English cmd.exe reject (exit 1, localized stderr)', async () => {
    // Regression: real Windows OpenSSH + cmd.exe forwards exit 1 (not 9009) with
    // localized stderr. The old 9009/English-string trigger silently missed this,
    // so German/Japanese/etc. hosts never fell back. Keying off the non-zero exit
    // of a RemoteBrowseError fixes it regardless of OS display language.
    const posixChannel = createMockChannel()
    const windowsChannel = createMockChannel()
    const exec = vi.fn().mockResolvedValueOnce(posixChannel).mockResolvedValueOnce(windowsChannel)
    const getConnectionManager = () => ({
      getConnection: () => ({ exec })
    })
    registerSshBrowseHandler(getConnectionManager as never)

    const resultPromise = handler(null, { targetId: 'ssh-1', dirPath: 'C:/Users' })
    await Promise.resolve()
    // Japanese cmd.exe "not recognized" text — matches none of the removed English
    // /Spanish substrings, and exit 1 is not the removed 9009 sentinel.
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
    // A cmd.exe reject exits 1 over SSH (its 9009 ERRORLEVEL never crosses the
    // process boundary) with localized German stderr. The fallback must still fire,
    // since it keys off the non-zero exit, not the (localized, unmatchable) text.
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
    posixChannel.emit('exit', 1)
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

  // The renderer rebuilds forward-slash Windows paths with POSIX helpers: the
  // breadcrumb prepends a spurious leading '/' before the drive, and "Up" from a
  // first-level dir yields a bare drive letter. Both must be rooted for
  // Set-Location, or navigation lands in the drive-relative cwd / errors.
  it.each([
    { dirPath: '/C:/Users', expected: "$dir = 'C:/Users'" },
    { dirPath: 'C:', expected: "$dir = 'C:/'" },
    // Combined strip + root, so a future refactor can't break the ordering.
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

      await expect(resultPromise).resolves.toEqual({ resolvedPath: 'C:/Users', entries: [] })
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
    // A genuine POSIX permission failure exits non-zero; it's indistinguishable
    // from a Windows shell reject without probing, so the fallback is attempted...
    posixChannel.stderr.emit('data', Buffer.from('ls: /root/secret: Permission denied'))
    posixChannel.emit('exit', 1)
    posixChannel.emit('close')
    await vi.waitFor(() => {
      expect(windowsChannel.listenerCount('close')).toBe(1)
    })
    // ...but on a POSIX host the login shell can't find powershell.exe (exit 127),
    // so the original permission error is surfaced, never masked by the retry.
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

    // PowerShell exited non-127, so it genuinely ran on a Windows host — its error
    // is the real cause. Surface it rather than the cmd.exe "not recognized" prose.
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
    // A non-zero POSIX failure triggers the fallback probe on any host...
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
    // A transport failure is not a RemoteBrowseError, so it must not trigger a
    // pointless PowerShell retry.
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
