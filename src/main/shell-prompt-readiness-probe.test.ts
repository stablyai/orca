import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const lineEditorProbe = vi.hoisted(() => vi.fn())
const processReadinessProbe = vi.hoisted(() => vi.fn())
const resolveExecutablePath = vi.hoisted(() => vi.fn((value: string) => Promise.resolve(value)))
vi.mock('../shared/pty-slave-line-discipline-echo', () => ({
  createPtySlaveLineEditorProbe: () => lineEditorProbe
}))
vi.mock('../shared/shell-process-readiness', () => ({
  readShellProcessReadiness: processReadinessProbe,
  resolveShellExecutablePath: resolveExecutablePath
}))

import { createShellPromptReadinessProbe } from './shell-prompt-readiness-probe'

describe('shell prompt readiness probe', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    lineEditorProbe.mockReset()
    processReadinessProbe.mockReset()
    resolveExecutablePath.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('accepts only the identified shell pid in line-editor mode and foreground', async () => {
    lineEditorProbe.mockResolvedValue('line-editor')
    processReadinessProbe.mockResolvedValue({ executablePath: '/bin/zsh', foreground: true })
    const onPromptReady = vi.fn()
    const probe = createShellPromptReadinessProbe({
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

  it('does no external work when the ready marker cancels the settle window', async () => {
    const probe = createShellPromptReadinessProbe({
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
