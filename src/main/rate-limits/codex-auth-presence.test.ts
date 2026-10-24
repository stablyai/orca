import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { statMock, homedirMock } = vi.hoisted(() => ({
  statMock: vi.fn(),
  homedirMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  stat: statMock
}))

vi.mock('node:os', () => ({
  homedir: homedirMock
}))

import { hasCodexAuthChangedSinceLastProbe, probeCodexAuthPresence } from './codex-auth-presence'

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

describe('probeCodexAuthPresence', () => {
  const originalCodexHome = process.env.CODEX_HOME

  beforeEach(() => {
    vi.clearAllMocks()
    homedirMock.mockReturnValue('/home/alice')
    delete process.env.CODEX_HOME
  })

  afterEach(() => {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME
    } else {
      process.env.CODEX_HOME = originalCodexHome
    }
  })

  it('checks an explicit managed-account home first', async () => {
    statMock.mockResolvedValue({ mtimeMs: 1, ctimeMs: 1, size: 20, ino: 2 })

    await expect(probeCodexAuthPresence('/managed/home')).resolves.toBe('present')
    expect(statMock).toHaveBeenCalledWith(join('/managed/home', 'auth.json'))
  })

  it('falls back to CODEX_HOME when no home is provided', async () => {
    process.env.CODEX_HOME = '/custom/codex'
    statMock.mockResolvedValue({ mtimeMs: 1, ctimeMs: 1, size: 20, ino: 2 })

    await expect(probeCodexAuthPresence()).resolves.toBe('present')
    expect(statMock).toHaveBeenCalledWith(join('/custom/codex', 'auth.json'))
  })

  it('falls back to ~/.codex when neither home nor CODEX_HOME is set', async () => {
    statMock.mockRejectedValue(fsError('ENOENT'))

    await expect(probeCodexAuthPresence()).resolves.toBe('absent')
    expect(statMock).toHaveBeenCalledWith(join('/home/alice', '.codex', 'auth.json'))
  })

  it('keeps an inaccessible auth path distinct from confirmed absence', async () => {
    statMock.mockRejectedValue(fsError('EACCES'))

    await expect(probeCodexAuthPresence('/managed/home')).resolves.toBe('unavailable')
  })

  it('confirms WSL auth absence only when the Codex home is reachable', async () => {
    statMock
      .mockRejectedValueOnce(fsError('ENOENT'))
      .mockResolvedValueOnce({ mtimeMs: 1, ctimeMs: 1, size: 20, ino: 2 })

    await expect(
      probeCodexAuthPresence('\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex')
    ).resolves.toBe('absent')
    expect(statMock).toHaveBeenCalledTimes(2)
  })

  it('reports unavailable when WSL cannot resolve either the auth file or its home', async () => {
    statMock.mockRejectedValue(fsError('ENOENT'))

    await expect(
      probeCodexAuthPresence('\\\\wsl.localhost\\Missing\\home\\alice\\.codex')
    ).resolves.toBe('unavailable')
    expect(statMock).toHaveBeenCalledTimes(2)
  })

  it('stops waiting for a stalled filesystem check when the caller aborts', async () => {
    let resolveAccess!: () => void
    statMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveAccess = resolve
      })
    )
    const controller = new AbortController()

    const result = probeCodexAuthPresence('/managed/home', { signal: controller.signal })
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()

    await expect(result).resolves.toBe('unavailable')
    resolveAccess()
    await Promise.resolve()
  })

  it('bounds a stalled filesystem check even without a caller signal', async () => {
    let resolveAccess!: () => void
    statMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveAccess = resolve
      })
    )
    const timeoutController = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal)

    const result = probeCodexAuthPresence('/managed/home')
    expect(timeout).toHaveBeenCalledWith(5_000)
    await Promise.resolve()
    await Promise.resolve()
    timeoutController.abort()

    await expect(result).resolves.toBe('timeout')
    resolveAccess()
    await Promise.resolve()
    timeout.mockRestore()
  })

  it('shares one stalled UNC probe across concurrent callers', async () => {
    let resolveAccess!: () => void
    statMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveAccess = resolve
      })
    )
    const firstController = new AbortController()
    const secondController = new AbortController()

    const first = probeCodexAuthPresence('\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex', {
      signal: firstController.signal
    })
    const second = probeCodexAuthPresence('\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex', {
      signal: secondController.signal
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(statMock).toHaveBeenCalledTimes(1)
    firstController.abort()
    secondController.abort()
    await expect(first).resolves.toBe('unavailable')
    await expect(second).resolves.toBe('unavailable')

    resolveAccess()
    await Promise.resolve()
  })

  it('does not interpret an unobserved home as a credential change', async () => {
    statMock.mockResolvedValue({ mtimeMs: 1, ctimeMs: 1, size: 20, ino: 2 })
    await expect(
      hasCodexAuthChangedSinceLastProbe('/unobserved/home', new AbortController().signal)
    ).resolves.toBe(false)
    expect(statMock).not.toHaveBeenCalled()
  })

  it('claims a metadata change only once across concurrent resume checks', async () => {
    const home = '/concurrent/reauthentication'
    statMock.mockResolvedValue({ mtimeMs: 1, ctimeMs: 1, size: 20, ino: 2 })
    await probeCodexAuthPresence(home)
    statMock.mockResolvedValue({ mtimeMs: 2, ctimeMs: 2, size: 20, ino: 3 })
    const signal = new AbortController().signal

    const changed = await Promise.all([
      hasCodexAuthChangedSinceLastProbe(home, signal),
      hasCodexAuthChangedSinceLastProbe(home, signal)
    ])

    expect(changed.filter(Boolean)).toHaveLength(1)
    await expect(hasCodexAuthChangedSinceLastProbe(home, signal)).resolves.toBe(false)
  })

  it('keeps the last known WSL fingerprint through a disconnected distro', async () => {
    const home = '\\\\wsl.localhost\\Offline\\home\\alice\\.codex'
    const signal = new AbortController().signal
    statMock.mockResolvedValue({ mtimeMs: 1, ctimeMs: 1, size: 20, ino: 2 })
    await probeCodexAuthPresence(home)
    statMock.mockRejectedValue(fsError('ENOENT'))
    await expect(hasCodexAuthChangedSinceLastProbe(home, signal)).resolves.toBe(false)
    statMock.mockResolvedValue({ mtimeMs: 2, ctimeMs: 2, size: 20, ino: 3 })
    await expect(hasCodexAuthChangedSinceLastProbe(home, signal)).resolves.toBe(true)
  })

  it('preserves a credential change until the caller can refresh', async () => {
    const home = '/deferred/reauthentication'
    const signal = new AbortController().signal
    statMock.mockResolvedValue({ mtimeMs: 1, ctimeMs: 1, size: 20, ino: 2 })
    await probeCodexAuthPresence(home)
    statMock.mockResolvedValue({ mtimeMs: 2, ctimeMs: 2, size: 20, ino: 3 })
    await expect(hasCodexAuthChangedSinceLastProbe(home, signal, () => false)).resolves.toBe(false)
    await expect(hasCodexAuthChangedSinceLastProbe(home, signal, () => true)).resolves.toBe(true)
  })

  it('bounds a stalled credential-change check without consuming its baseline', async () => {
    const home = '/stalled/reauthentication'
    statMock.mockResolvedValue({ mtimeMs: 1, ctimeMs: 1, size: 20, ino: 2 })
    await probeCodexAuthPresence(home)
    let finishStat!: (value: {
      mtimeMs: number
      ctimeMs: number
      size: number
      ino: number
    }) => void
    statMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishStat = resolve
        })
    )
    const timeout = new AbortController()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    const signal = new AbortController().signal
    const changed = hasCodexAuthChangedSinceLastProbe(home, signal)
    await Promise.resolve()
    await Promise.resolve()
    timeout.abort()
    await expect(changed).resolves.toBe(false)
    finishStat({ mtimeMs: 2, ctimeMs: 2, size: 20, ino: 3 })
    timeoutSpy.mockRestore()
    await Promise.resolve()
    statMock.mockResolvedValue({ mtimeMs: 2, ctimeMs: 2, size: 20, ino: 3 })
    await expect(hasCodexAuthChangedSinceLastProbe(home, signal)).resolves.toBe(true)
  })
})
