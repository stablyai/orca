import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const lineEditorProbe = vi.hoisted(() => vi.fn())
const processReadinessProbe = vi.hoisted(() => vi.fn())
const terminalPathProbe = vi.hoisted(() => vi.fn())
const resolveExecutablePath = vi.hoisted(() => vi.fn((value: string) => Promise.resolve(value)))
const resolveInstalledExecutablePaths = vi.hoisted(() =>
  vi.fn((): Promise<string[]> => Promise.resolve([]))
)
vi.mock('../shared/pty-slave-line-discipline-echo', () => ({
  createPtySlaveLineEditorProbe: (path: string | undefined) => (path ? lineEditorProbe : undefined)
}))
vi.mock('../shared/shell-process-readiness', () => ({
  readShellProcessReadiness: processReadinessProbe,
  readShellTerminalPath: terminalPathProbe,
  resolveShellExecutablePath: resolveExecutablePath,
  resolveInstalledShellExecutablePaths: resolveInstalledExecutablePaths
}))

import { createShellPromptReadinessProbe } from './shell-prompt-readiness-probe'

describe('shell prompt readiness probe', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    lineEditorProbe.mockReset()
    processReadinessProbe.mockReset()
    terminalPathProbe.mockReset()
    resolveExecutablePath.mockClear()
    resolveInstalledExecutablePaths.mockClear()
    resolveInstalledExecutablePaths.mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.skipIf(process.platform === 'win32')(
    'discovers the Bun terminal device only after prompt output, retaining line-editor checks',
    async () => {
      terminalPathProbe.mockResolvedValue('/dev/ttys048')
      lineEditorProbe.mockResolvedValue('other')
      processReadinessProbe.mockResolvedValue({ executablePath: '/bin/zsh', foreground: true })
      const onPromptReady = vi.fn()
      const probe = createShellPromptReadinessProbe({
        ptyPid: 41,
        slavePath: undefined,
        shellPath: '/bin/zsh',
        getShellPid: () => 42,
        onPromptReady
      })
      expect(terminalPathProbe).not.toHaveBeenCalled()
      probe!.notifyOutput('\x1b[?2004h')
      await vi.advanceTimersByTimeAsync(50)
      expect(terminalPathProbe).toHaveBeenCalledExactlyOnceWith(42, 41)
      expect(onPromptReady).not.toHaveBeenCalled()
      terminalPathProbe.mockResolvedValueOnce(null)
      probe!.notifyOutput('\x1b[?2004h')
      await vi.advanceTimersByTimeAsync(50)
      expect(lineEditorProbe).toHaveBeenCalledOnce()
      lineEditorProbe.mockResolvedValue('line-editor')
      probe!.notifyOutput('\x1b[?2004h')
      await vi.advanceTimersByTimeAsync(50)
      expect(onPromptReady).toHaveBeenCalledOnce()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'does not accept a late device discovery after disposal',
    async () => {
      let resolvePath!: (path: string) => void
      terminalPathProbe.mockReturnValue(
        new Promise<string>((resolve) => {
          resolvePath = resolve
        })
      )
      const onPromptReady = vi.fn()
      const probe = createShellPromptReadinessProbe({
        ptyPid: 41,
        slavePath: undefined,
        shellPath: '/bin/zsh',
        getShellPid: () => 42,
        onPromptReady
      })
      probe!.notifyOutput('\x1b[?2004h')
      await vi.advanceTimersByTimeAsync(50)
      probe!.dispose()
      resolvePath('/dev/ttys048')
      await vi.advanceTimersByTimeAsync(0)
      expect(lineEditorProbe).not.toHaveBeenCalled()
      expect(onPromptReady).not.toHaveBeenCalled()
    }
  )

  it('accepts only the identified shell pid in line-editor mode and foreground', async () => {
    lineEditorProbe.mockResolvedValue('line-editor')
    processReadinessProbe.mockResolvedValue({ executablePath: '/bin/zsh', foreground: true })
    const onPromptReady = vi.fn()
    const probe = createShellPromptReadinessProbe({
      ptyPid: 41,
      slavePath: '/dev/ttys048',
      shellPath: '/bin/zsh',
      getShellPid: () => 42,
      onPromptReady,
      settleMs: 10
    })

    probe?.notifyOutput('\x1b[?2004h')
    await vi.advanceTimersByTimeAsync(10)

    expect(onPromptReady).toHaveBeenCalledOnce()
  })

  it('preserves an unset child PATH for executable resolution', async () => {
    lineEditorProbe.mockResolvedValue('line-editor')
    processReadinessProbe.mockResolvedValue({ executablePath: '/bin/zsh', foreground: true })
    const probe = createShellPromptReadinessProbe({
      ptyPid: 41,
      slavePath: '/dev/ttys048',
      shellPath: '/bin/zsh',
      getShellPid: () => 42,
      onPromptReady: vi.fn(),
      settleMs: 10
    })

    probe?.notifyOutput('\x1b[?2004h')
    await vi.advanceTimersByTimeAsync(10)

    expect(resolveExecutablePath).toHaveBeenCalledWith('/bin/zsh', process.cwd(), undefined)
  })

  it.each([
    ['silent read', 'other', { executablePath: '/bin/zsh', foreground: true }],
    ['background shell', 'line-editor', { executablePath: '/bin/zsh', foreground: false }],
    ['different foreground process', 'line-editor', null],
    [
      'non-shell replacement image',
      'line-editor',
      { executablePath: '/usr/bin/sqlite3', foreground: true }
    ],
    [
      'non-shell image with the shell basename',
      'line-editor',
      { executablePath: '/tmp/zsh', foreground: true }
    ]
  ])('rejects %s', async (_name, terminalState, rows) => {
    lineEditorProbe.mockResolvedValue(terminalState)
    processReadinessProbe.mockResolvedValue(rows)
    const onPromptReady = vi.fn()
    const probe = createShellPromptReadinessProbe({
      ptyPid: 41,
      slavePath: '/dev/ttys048',
      shellPath: '/bin/zsh',
      getShellPid: () => 42,
      onPromptReady,
      settleMs: 10
    })

    probe?.notifyOutput('\x1b[?2004h')
    await vi.advanceTimersByTimeAsync(10)

    expect(onPromptReady).not.toHaveBeenCalled()
    if (terminalState === 'other') {
      expect(processReadinessProbe).not.toHaveBeenCalled()
    }
  })

  it('accepts a second installation of the same shell that the pane PATH resolves', async () => {
    lineEditorProbe.mockResolvedValue('line-editor')
    processReadinessProbe.mockResolvedValue({
      executablePath: '/opt/homebrew/bin/bash',
      foreground: true
    })
    resolveInstalledExecutablePaths.mockResolvedValue(['/bin/bash', '/opt/homebrew/bin/bash'])
    const onPromptReady = vi.fn()
    const probe = createShellPromptReadinessProbe({
      ptyPid: 41,
      slavePath: '/dev/ttys048',
      shellPath: '/bin/bash',
      shellCwd: '/work',
      shellPathEnv: '/opt/homebrew/bin:/usr/bin:/bin',
      getShellPid: () => 42,
      onPromptReady,
      settleMs: 10
    })

    probe?.notifyOutput('\x1b[?2004h')
    await vi.advanceTimersByTimeAsync(10)

    expect(resolveInstalledExecutablePaths).toHaveBeenCalledWith(
      'bash',
      '/work',
      '/opt/homebrew/bin:/usr/bin:/bin'
    )
    expect(onPromptReady).toHaveBeenCalledOnce()
  })

  it('rejects a replacement with the shell basename that the pane PATH cannot reach', async () => {
    lineEditorProbe.mockResolvedValue('line-editor')
    processReadinessProbe.mockResolvedValue({ executablePath: '/tmp/bash', foreground: true })
    resolveInstalledExecutablePaths.mockResolvedValue(['/bin/bash', '/opt/homebrew/bin/bash'])
    const onPromptReady = vi.fn()
    const probe = createShellPromptReadinessProbe({
      ptyPid: 41,
      slavePath: '/dev/ttys048',
      shellPath: '/bin/bash',
      getShellPid: () => 42,
      onPromptReady,
      settleMs: 10
    })

    probe?.notifyOutput('\x1b[?2004h')
    await vi.advanceTimersByTimeAsync(10)

    expect(onPromptReady).not.toHaveBeenCalled()
  })

  it('does not widen identity when the launched shell path resolves exactly', async () => {
    lineEditorProbe.mockResolvedValue('line-editor')
    processReadinessProbe.mockResolvedValue({ executablePath: '/bin/zsh', foreground: true })
    const probe = createShellPromptReadinessProbe({
      ptyPid: 41,
      slavePath: '/dev/ttys048',
      shellPath: '/bin/zsh',
      getShellPid: () => 42,
      onPromptReady: vi.fn(),
      settleMs: 10
    })

    probe?.notifyOutput('\x1b[?2004h')
    await vi.advanceTimersByTimeAsync(10)

    expect(resolveInstalledExecutablePaths).not.toHaveBeenCalled()
  })

  it('invalidates an alternate-installation result that resolves after disposal', async () => {
    const pending: { resolve?: (value: string[]) => void } = {}
    lineEditorProbe.mockResolvedValue('line-editor')
    processReadinessProbe.mockResolvedValue({
      executablePath: '/opt/homebrew/bin/bash',
      foreground: true
    })
    resolveInstalledExecutablePaths.mockImplementation(
      () => new Promise((resolve) => (pending.resolve = resolve))
    )
    const onPromptReady = vi.fn()
    const probe = createShellPromptReadinessProbe({
      ptyPid: 41,
      slavePath: '/dev/ttys048',
      shellPath: '/bin/bash',
      getShellPid: () => 42,
      onPromptReady,
      settleMs: 10
    })

    probe?.notifyOutput('\x1b[?2004h')
    await vi.advanceTimersByTimeAsync(10)
    probe?.dispose()
    pending.resolve?.(['/opt/homebrew/bin/bash'])
    await vi.advanceTimersByTimeAsync(0)

    expect(onPromptReady).not.toHaveBeenCalled()
  })

  it('does no external work when the ready marker cancels the settle window', async () => {
    const probe = createShellPromptReadinessProbe({
      ptyPid: 41,
      slavePath: '/dev/ttys048',
      shellPath: '/bin/zsh',
      getShellPid: () => 42,
      onPromptReady: vi.fn(),
      settleMs: 10
    })

    probe?.notifyOutput('\x1b[?2004h')
    probe?.dispose()
    await vi.advanceTimersByTimeAsync(10)

    expect(lineEditorProbe).not.toHaveBeenCalled()
    expect(processReadinessProbe).not.toHaveBeenCalled()
  })

  it('invalidates an in-flight result when newer output arrives', async () => {
    const pending: { resolve?: (value: string) => void } = {}
    lineEditorProbe.mockImplementation(
      () => new Promise((resolve) => (pending.resolve = resolve as (value: string) => void))
    )
    processReadinessProbe.mockResolvedValue({ executablePath: '/bin/zsh', foreground: true })
    const onPromptReady = vi.fn()
    const probe = createShellPromptReadinessProbe({
      ptyPid: 41,
      slavePath: '/dev/ttys048',
      shellPath: '/bin/zsh',
      getShellPid: () => 42,
      onPromptReady,
      settleMs: 10
    })

    probe?.notifyOutput('\x1b[?2004h')
    await vi.advanceTimersByTimeAsync(10)
    probe?.notifyOutput('\x1b[?2004h')
    pending.resolve?.('line-editor')
    await vi.advanceTimersByTimeAsync(0)

    expect(onPromptReady).not.toHaveBeenCalled()
    expect(processReadinessProbe).not.toHaveBeenCalled()
  })

  it('does not inspect a process after disposal during a line-editor probe', async () => {
    const pending: { resolve?: (value: string) => void } = {}
    lineEditorProbe.mockImplementation(
      () => new Promise((resolve) => (pending.resolve = resolve as (value: string) => void))
    )
    const probe = createShellPromptReadinessProbe({
      ptyPid: 41,
      slavePath: '/dev/ttys048',
      shellPath: '/bin/zsh',
      getShellPid: () => 42,
      onPromptReady: vi.fn(),
      settleMs: 10
    })

    probe?.notifyOutput('\x1b[?2004h')
    await vi.advanceTimersByTimeAsync(10)
    probe?.dispose()
    pending.resolve?.('line-editor')
    await vi.advanceTimersByTimeAsync(0)

    expect(processReadinessProbe).not.toHaveBeenCalled()
  })

  it('invalidates process readiness that resolves after disposal', async () => {
    const pending: { resolve?: (value: { executablePath: string; foreground: boolean }) => void } =
      {}
    lineEditorProbe.mockResolvedValue('line-editor')
    processReadinessProbe.mockImplementation(
      () => new Promise((resolve) => (pending.resolve = resolve))
    )
    const onPromptReady = vi.fn()
    const probe = createShellPromptReadinessProbe({
      ptyPid: 41,
      slavePath: '/dev/ttys048',
      shellPath: '/bin/zsh',
      getShellPid: () => 42,
      onPromptReady,
      settleMs: 10
    })

    probe?.notifyOutput('\x1b[?2004h')
    await vi.advanceTimersByTimeAsync(10)
    probe?.dispose()
    pending.resolve?.({ executablePath: '/bin/zsh', foreground: true })
    await vi.advanceTimersByTimeAsync(0)

    expect(onPromptReady).not.toHaveBeenCalled()
  })

  it('ignores slow startup output until the line editor enables its protocol', async () => {
    const probe = createShellPromptReadinessProbe({
      ptyPid: 41,
      slavePath: '/dev/ttys048',
      shellPath: '/bin/zsh',
      getShellPid: () => 42,
      onPromptReady: vi.fn(),
      settleMs: 10
    })

    for (let index = 0; index < 20; index += 1) {
      probe?.notifyOutput(`startup ${index}\n`)
      await vi.advanceTimersByTimeAsync(20)
    }

    expect(lineEditorProbe).not.toHaveBeenCalled()
    expect(processReadinessProbe).not.toHaveBeenCalled()
  })

  it('bounds rejected line-editor retries', async () => {
    lineEditorProbe.mockResolvedValue('line-editor')
    processReadinessProbe.mockResolvedValue({
      executablePath: '/usr/bin/sqlite3',
      foreground: true
    })
    const probe = createShellPromptReadinessProbe({
      ptyPid: 41,
      slavePath: '/dev/ttys048',
      shellPath: '/bin/zsh',
      getShellPid: () => 42,
      onPromptReady: vi.fn(),
      settleMs: 10
    })

    for (let index = 0; index < 10; index += 1) {
      probe?.notifyOutput('\x1b[?2004h')
      await vi.advanceTimersByTimeAsync(10)
    }

    expect(lineEditorProbe).toHaveBeenCalledTimes(4)
    expect(processReadinessProbe).toHaveBeenCalledTimes(4)
  })
})
