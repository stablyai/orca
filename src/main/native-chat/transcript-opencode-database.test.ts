import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type { OpenCodeTranscriptSignal } from './transcript-opencode-sqlite-query'
import { WslTranscriptFsError } from './wsl-transcript-fs-error'

const mocks = vi.hoisted(() => ({
  homes: vi.fn(async (): Promise<string[]> => []),
  native: vi.fn(async (): Promise<string[]> => []),
  directory: vi.fn(
    async (
      _path: string,
      _onRefusal?: (path: string, error: WslTranscriptFsError) => void
    ): Promise<string[]> => []
  ),
  prepare: vi.fn(async () => []),
  configure: vi.fn(),
  wslPath: vi.fn((_path: string): { distro: string; linuxPath: string } | null => null),
  readSignal: vi.fn(
    async (
      _args: { dbPath: string; sessionId: string },
      _signal?: AbortSignal
    ): Promise<OpenCodeTranscriptSignal | null> => null
  )
}))
vi.mock('../ai-vault/cached-session-list', () => ({ getAiVaultWslHomeDirs: mocks.homes }))
vi.mock('../opencode-usage/opencode-database-discovery', () => ({
  listOpenCodeDatabases: mocks.native,
  listOpenCodeDatabasesInDirectory: mocks.directory,
  compareOpenCodeClaimPriority: (a: string, b: string) => a.localeCompare(b)
}))
vi.mock('../ai-vault/opencode-wsl-runtime-preparation', () => ({
  prepareOpenCodeWslReaders: mocks.prepare
}))
vi.mock('../ai-vault/session-scanner-opencode-wsl-client', () => ({
  configureOpenCodeWslReaders: mocks.configure,
  openCodeWslPath: mocks.wslPath
}))
vi.mock('../ai-vault/session-scanner-opencode-sqlite-worker-spawn', () => ({
  readOpenCodeTranscriptSignalViaWorker: mocks.readSignal,
  readOpenCodeTranscriptPageViaWorker: vi.fn()
}))
import {
  resolveOpenCodeTranscriptDbPath,
  openCodeTranscriptDefaultDeps
} from './transcript-opencode'

afterEach(() => {
  vi.resetAllMocks()
  vi.useRealTimers()
})

describe('OpenCode transcript owning-host database discovery', () => {
  it.each(['homes', 'directory', 'prepare'] as const)(
    'opens a matching native database without waiting for WSL %s',
    async (stage) => {
      vi.useFakeTimers()
      mocks.native.mockResolvedValue(['native.db'])
      mocks.homes.mockResolvedValue(['wsl-home'])
      mocks[stage].mockImplementation(() => new Promise(() => {}))
      mocks.readSignal.mockResolvedValue({
        messageCount: 1,
        partCount: 1,
        maxMessageRowId: 1,
        maxPartTimeUpdated: 1
      })
      const settled = vi.fn()
      void resolveOpenCodeTranscriptDbPath('session').then(settled, settled)
      await vi.advanceTimersByTimeAsync(50)
      expect(settled).toHaveBeenCalledWith('native.db')
      expect(mocks.readSignal).toHaveBeenCalledOnce()
      expect(mocks.prepare).not.toHaveBeenCalled()
    }
  )

  it('finds a WSL-only session using the same running homes and database discovery as Vault', async () => {
    const home = 'wsl-home'
    const dbPath = join(home, '.local', 'share', 'opencode', 'opencode.db')
    mocks.homes.mockResolvedValue([home])
    mocks.directory.mockResolvedValue([dbPath])
    mocks.readSignal.mockResolvedValue(null)
    mocks.readSignal.mockImplementation(async () => ({
      messageCount: 1,
      partCount: 1,
      maxMessageRowId: 1,
      maxPartTimeUpdated: 1
    }))
    await expect(resolveOpenCodeTranscriptDbPath('session')).resolves.toBe(dbPath)
    expect(mocks.directory).toHaveBeenCalledWith(
      join(home, '.local', 'share', 'opencode'),
      expect.any(Function),
      expect.any(AbortSignal)
    )
    expect(mocks.prepare).toHaveBeenCalledWith([home])
    expect(mocks.configure).toHaveBeenCalledOnce()
    expect(mocks.readSignal).toHaveBeenCalledWith(
      { dbPath, sessionId: 'session' },
      expect.any(AbortSignal)
    )
  })

  it('caps candidate probes when a session is missing', async () => {
    mocks.native.mockResolvedValue(Array.from({ length: 40 }, (_, index) => `db-${index}`))
    await expect(resolveOpenCodeTranscriptDbPath('missing')).resolves.toBe(null)
    expect(mocks.readSignal).toHaveBeenCalledTimes(32)
  })

  it.each(['database is locked', 'file is not a database', 'Preparing the WSL SQLite reader…'])(
    'continues to the next candidate after %s',
    async (message) => {
      mocks.native.mockResolvedValue(['a.db', 'b.db'])
      mocks.readSignal.mockRejectedValueOnce(new Error(message)).mockResolvedValueOnce({
        messageCount: 1,
        partCount: 1,
        maxMessageRowId: 1,
        maxPartTimeUpdated: 1
      })
      await expect(resolveOpenCodeTranscriptDbPath('session')).resolves.toBe('b.db')
      expect(mocks.readSignal).toHaveBeenCalledTimes(2)
    }
  )

  it('retains the first probe failure when no candidate has the session', async () => {
    const refusal = new Error('database is locked')
    mocks.native.mockResolvedValue(['a.db', 'b.db'])
    mocks.readSignal.mockRejectedValueOnce(refusal).mockResolvedValueOnce(null)
    await expect(resolveOpenCodeTranscriptDbPath('session')).rejects.toBe(refusal)
    expect(mocks.readSignal).toHaveBeenCalledTimes(2)
  })

  it('continues past an unprepared WSL reader to another owning-host candidate', async () => {
    const home = 'wsl-home'
    const failedPath = join(home, '.local', 'share', 'opencode', 'opencode-a.db')
    const matchingPath = join(home, '.local', 'share', 'opencode', 'opencode-b.db')
    mocks.homes.mockResolvedValue([home])
    mocks.directory.mockResolvedValue([failedPath, matchingPath])
    mocks.readSignal
      .mockRejectedValueOnce(new Error('Preparing the WSL SQLite reader…'))
      .mockResolvedValueOnce({
        messageCount: 1,
        partCount: 1,
        maxMessageRowId: 1,
        maxPartTimeUpdated: 1
      })
    await expect(resolveOpenCodeTranscriptDbPath('session')).resolves.toBe(matchingPath)
    expect(mocks.prepare).toHaveBeenCalledOnce()
    expect(mocks.configure).toHaveBeenCalledOnce()
    expect(mocks.readSignal).toHaveBeenCalledTimes(2)
  })

  it('caps failed probes as well as missing-session probes', async () => {
    const error = new Error('file is not a database')
    mocks.native.mockResolvedValue(Array.from({ length: 40 }, (_, index) => `db-${index}`))
    mocks.readSignal.mockRejectedValue(error)
    await expect(resolveOpenCodeTranscriptDbPath('session')).rejects.toBe(error)
    expect(mocks.readSignal).toHaveBeenCalledTimes(32)
  })

  it('rethrows cancellation during a probe without trying the next candidate', async () => {
    const controller = new AbortController()
    const reason = new Error('caller cancelled the probe')
    mocks.native.mockResolvedValue(['a.db', 'b.db'])
    mocks.readSignal.mockImplementationOnce(async () => {
      controller.abort(reason)
      throw new Error('database is locked')
    })
    await expect(
      openCodeTranscriptDefaultDeps.resolveDbPath('session', controller.signal)
    ).rejects.toBe(reason)
    expect(mocks.readSignal).toHaveBeenCalledOnce()
  })

  it('prepares an overridden WSL database before its owning-host probe', async () => {
    const dbPath = '\\\\wsl.localhost\\Ubuntu\\custom\\opencode.db'
    mocks.native.mockResolvedValue([dbPath])
    mocks.wslPath.mockReturnValue({ distro: 'Ubuntu', linuxPath: '/custom/opencode.db' })
    mocks.readSignal.mockImplementation(async () => {
      expect(mocks.configure).toHaveBeenCalledOnce()
      return { messageCount: 1, partCount: 1, maxMessageRowId: 1, maxPartTimeUpdated: 1 }
    })
    await expect(resolveOpenCodeTranscriptDbPath('session')).resolves.toBe(dbPath)
    expect(mocks.prepare).toHaveBeenCalledWith([dbPath])
    expect(mocks.readSignal).toHaveBeenCalledOnce()
  })

  it('reports a refused WSL read instead of treating that host as empty', async () => {
    mocks.homes.mockResolvedValue(['wsl-home'])
    const refusal = new WslTranscriptFsError('unavailable', 'WSL discovery unavailable')
    mocks.directory.mockImplementation(async (path, onRefusal) => {
      onRefusal?.(path, refusal)
      return []
    })
    await expect(resolveOpenCodeTranscriptDbPath('session')).rejects.toBe(refusal)
  })

  it('aborts a slow candidate within the discovery deadline, including its in-flight read', async () => {
    vi.useFakeTimers()
    mocks.native.mockResolvedValue(['slow.db'])
    mocks.readSignal.mockImplementation(() => new Promise(() => {}))
    const pending = resolveOpenCodeTranscriptDbPath('session')
    const assertion = expect(pending).rejects.toThrow('database discovery exceeded its time limit')
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
    const readSignal = mocks.readSignal.mock.calls[0]?.[1]
    expect(readSignal?.aborted).toBe(true)
  })

  it('propagates caller cancellation rather than reporting a missing local transcript', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(
      openCodeTranscriptDefaultDeps.resolveDbPath('session', controller.signal)
    ).rejects.toThrow('cancelled')
    expect(mocks.readSignal).not.toHaveBeenCalled()
  })
})
