import { describe, expect, it, vi } from 'vitest'
import { createAuthFilesystemOperation } from './auth-filesystem-operation'

describe('createAuthFilesystemOperation', () => {
  it('serializes WSL aliases by distro and drops an abandoned queued read', async () => {
    let resolveFirst!: (value: string) => void
    const firstRaw = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveFirst = resolve
        })
    )
    const secondRaw = vi.fn(async () => 'second')
    const first = createAuthFilesystemOperation(
      '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex\\auth.json',
      firstRaw
    )
    const second = createAuthFilesystemOperation(
      '\\\\WSL$\\ubuntu\\home\\alice\\managed\\auth.json',
      secondRaw
    )
    const firstController = new AbortController()
    const secondController = new AbortController()

    const firstWait = first.wait(firstController.signal)
    const secondWait = second.wait(secondController.signal)
    await Promise.resolve()
    await Promise.resolve()
    expect(firstRaw).toHaveBeenCalledOnce()
    expect(secondRaw).not.toHaveBeenCalled()

    const queuedAbort = new Error('queued caller expired')
    secondController.abort(queuedAbort)
    await expect(secondWait).rejects.toBe(queuedAbort)

    resolveFirst('first')
    await expect(firstWait).resolves.toBe('first')
    await expect(second.result).rejects.toBe(queuedAbort)
    expect(secondRaw).not.toHaveBeenCalled()
  })

  it('allows different WSL distros to probe concurrently', async () => {
    const ubuntuRaw = vi.fn(async () => 'ubuntu')
    const debianRaw = vi.fn(async () => 'debian')
    const ubuntu = createAuthFilesystemOperation(
      '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex\\auth.json',
      ubuntuRaw
    )
    const debian = createAuthFilesystemOperation(
      '\\\\wsl.localhost\\Debian\\home\\alice\\.codex\\auth.json',
      debianRaw
    )
    const controller = new AbortController()

    await expect(
      Promise.all([ubuntu.wait(controller.signal), debian.wait(controller.signal)])
    ).resolves.toEqual(['ubuntu', 'debian'])
    expect(ubuntuRaw).toHaveBeenCalledOnce()
    expect(debianRaw).toHaveBeenCalledOnce()
  })

  it('does not start an operation for an already-aborted waiter', async () => {
    const raw = vi.fn(async () => 'unexpected')
    const operation = createAuthFilesystemOperation(
      '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex\\auth.json',
      raw
    )
    const controller = new AbortController()
    const abortError = new Error('already expired')
    controller.abort(abortError)

    await expect(operation.wait(controller.signal)).rejects.toBe(abortError)
    await expect(operation.result).rejects.toBe(abortError)
    expect(raw).not.toHaveBeenCalled()
  })

  it('caps cross-distro operations and never starts an expired queued probe', async () => {
    let resolveUbuntu!: (value: string) => void
    let resolveDebian!: (value: string) => void
    const ubuntuRaw = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveUbuntu = resolve
        })
    )
    const debianRaw = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveDebian = resolve
        })
    )
    const fedoraRaw = vi.fn(async () => 'fedora')
    const ubuntu = createAuthFilesystemOperation('\\\\wsl$\\Ubuntu\\a\\auth.json', ubuntuRaw)
    const debian = createAuthFilesystemOperation('\\\\wsl$\\Debian\\b\\auth.json', debianRaw)
    const fedora = createAuthFilesystemOperation('\\\\wsl$\\Fedora\\c\\auth.json', fedoraRaw)
    const ubuntuController = new AbortController()
    const debianController = new AbortController()
    const fedoraController = new AbortController()

    const ubuntuWait = ubuntu.wait(ubuntuController.signal)
    const debianWait = debian.wait(debianController.signal)
    const fedoraWait = fedora.wait(fedoraController.signal)
    await Promise.resolve()
    await Promise.resolve()
    expect(ubuntuRaw).toHaveBeenCalledOnce()
    expect(debianRaw).toHaveBeenCalledOnce()
    expect(fedoraRaw).not.toHaveBeenCalled()

    const queuedAbort = new Error('global queue expired')
    fedoraController.abort(queuedAbort)
    await expect(fedoraWait).rejects.toBe(queuedAbort)
    await expect(fedora.result).rejects.toBe(queuedAbort)

    resolveUbuntu('ubuntu')
    resolveDebian('debian')
    await expect(Promise.all([ubuntuWait, debianWait])).resolves.toEqual(['ubuntu', 'debian'])
    expect(fedoraRaw).not.toHaveBeenCalled()
  })
})
