import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TerminalHistory from '../terminal-history'

const { handleMock, ensureHistoryDirMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  ensureHistoryDirMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock }
}))

// Why: only ensureHistoryDir touches disk/electron's app.getPath; resolveShellKind,
// historyFilename, and hashWorktreeId are pure and safe to keep real.
vi.mock('../terminal-history', async (importOriginal) => {
  const actual = await importOriginal<typeof TerminalHistory>()
  return {
    ...actual,
    ensureHistoryDir: ensureHistoryDirMock
  }
})

import { readFile } from 'node:fs/promises'
import {
  readTerminalHistoryFile,
  registerTerminalHistoryFileHandlers
} from './terminal-history-file'

const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('readTerminalHistoryFile', () => {
  beforeEach(() => {
    vi.mocked(readFile).mockReset()
    ensureHistoryDirMock.mockReset()
    setPlatform('linux')
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    vi.unstubAllEnvs()
  })

  it('returns null for an explicit shell with no HISTFILE support (e.g. fish)', async () => {
    const result = await readTerminalHistoryFile({
      worktreeId: 'w1',
      shellPath: '/usr/bin/fish'
    })
    expect(result).toBeNull()
  })

  it('returns null when the history file does not exist yet (ENOENT)', async () => {
    ensureHistoryDirMock.mockReturnValue('/fake/history/dir')
    vi.mocked(readFile).mockRejectedValueOnce(
      Object.assign(new Error('no such file'), { code: 'ENOENT' })
    )

    const result = await readTerminalHistoryFile({ worktreeId: 'w1', shellPath: '/bin/bash' })

    expect(result).toBeNull()
  })

  it('rethrows non-ENOENT read errors instead of swallowing them', async () => {
    ensureHistoryDirMock.mockReturnValue('/fake/history/dir')
    vi.mocked(readFile).mockRejectedValueOnce(
      Object.assign(new Error('permission denied'), { code: 'EACCES' })
    )

    await expect(
      readTerminalHistoryFile({ worktreeId: 'w1', shellPath: '/bin/bash' })
    ).rejects.toThrow('permission denied')
  })

  it('returns the raw content plus resolved kind on success (explicit shell)', async () => {
    ensureHistoryDirMock.mockReturnValue('/fake/history/dir')
    vi.mocked(readFile).mockResolvedValueOnce('cmd1\ncmd2\n')

    const result = await readTerminalHistoryFile({ worktreeId: 'w1', shellPath: '/bin/bash' })

    expect(result).toEqual({ content: 'cmd1\ncmd2\n', shell: 'bash' })
  })

  it('resolves the host default login shell when no shellPath is given (zsh)', async () => {
    ensureHistoryDirMock.mockReturnValue('/fake/history/dir')
    vi.stubEnv('SHELL', '/bin/zsh')
    vi.mocked(readFile).mockResolvedValueOnce('a\nb\n')

    const result = await readTerminalHistoryFile({ worktreeId: 'w1' })

    expect(result).toEqual({ content: 'a\nb\n', shell: 'zsh' })
  })

  it('resolves the host default login shell when no shellPath is given (bash)', async () => {
    ensureHistoryDirMock.mockReturnValue('/fake/history/dir')
    vi.stubEnv('SHELL', '/usr/bin/bash')
    vi.mocked(readFile).mockResolvedValueOnce('x\n')

    const result = await readTerminalHistoryFile({ worktreeId: 'w1' })

    expect(result).toEqual({ content: 'x\n', shell: 'bash' })
  })

  it('returns null (no default) when no shellPath is given on Windows', async () => {
    setPlatform('win32')
    const result = await readTerminalHistoryFile({ worktreeId: 'w1' })

    expect(result).toBeNull()
    expect(ensureHistoryDirMock).not.toHaveBeenCalled()
  })
})

describe('registerTerminalHistoryFileHandlers', () => {
  beforeEach(() => {
    vi.mocked(readFile).mockReset()
    ensureHistoryDirMock.mockReset()
    handleMock.mockReset()
    setPlatform('linux')
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    vi.unstubAllEnvs()
  })

  function getRegisteredHandler(): (
    event: unknown,
    args: unknown
  ) => Promise<{ content: string; shell: 'bash' | 'zsh' } | null> {
    registerTerminalHistoryFileHandlers()
    const call = handleMock.mock.calls.find(([channel]) => channel === 'terminal:readHistoryFile')
    if (!call) {
      throw new Error('terminal:readHistoryFile handler was not registered')
    }
    return call[1] as (
      event: unknown,
      args: unknown
    ) => Promise<{ content: string; shell: 'bash' | 'zsh' } | null>
  }

  it('returns null without touching the filesystem when worktreeId is not a string', async () => {
    const handler = getRegisteredHandler()

    const result = await handler({}, { worktreeId: 123, shellPath: '/bin/bash' })

    expect(result).toBeNull()
    expect(ensureHistoryDirMock).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
  })

  it('returns null without touching the filesystem when args are missing entirely', async () => {
    const handler = getRegisteredHandler()

    const result = await handler({}, undefined)

    expect(result).toBeNull()
    expect(ensureHistoryDirMock).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
  })

  it('accepts a worktreeId with no shellPath and resolves the default shell', async () => {
    ensureHistoryDirMock.mockReturnValue('/fake/history/dir')
    vi.stubEnv('SHELL', '/bin/zsh')
    vi.mocked(readFile).mockResolvedValueOnce('c\n')
    const handler = getRegisteredHandler()

    const result = await handler({}, { worktreeId: 'w1' })

    expect(result).toEqual({ content: 'c\n', shell: 'zsh' })
  })
})
