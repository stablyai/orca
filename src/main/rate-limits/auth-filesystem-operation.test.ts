import { describe, expect, it, vi } from 'vitest'
import {
  AuthFilesystemOperationLimitError,
  AuthFilesystemOperationRegistry,
  createAuthFilesystemOperation,
  MAX_AUTH_FILESYSTEM_OPERATION_PATH_BYTES,
  MAX_AUTH_FILESYSTEM_OPERATION_WAITERS,
  MAX_AUTH_FILESYSTEM_REGISTRY_ENTRIES,
  MAX_QUEUED_WSL_AUTH_OPERATIONS
} from './auth-filesystem-operation'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

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

  it('caps retained operations, coalesces existing paths at saturation, and recovers', async () => {
    const registry = new AuthFilesystemOperationRegistry<string>()
    const deferredReads = Array.from({ length: MAX_AUTH_FILESYSTEM_REGISTRY_ENTRIES + 1 }, () =>
      deferred<string>()
    )
    const operations = deferredReads
      .slice(0, MAX_AUTH_FILESYSTEM_REGISTRY_ENTRIES)
      .map((read, index) => registry.getOrCreate(`/auth/${index}`, () => read.promise))

    expect(operations.every((operation) => operation !== null)).toBe(true)
    expect(registry.size).toBe(MAX_AUTH_FILESYSTEM_REGISTRY_ENTRIES)
    expect(registry.getOrCreate('/auth/0', async () => 'duplicate')).toBe(operations[0])
    const overflowRaw = vi.fn(async () => 'overflow')
    expect(registry.getOrCreate('/auth/overflow', overflowRaw)).toBeNull()
    expect(overflowRaw).not.toHaveBeenCalled()

    deferredReads[0]!.resolve('first')
    await expect(operations[0]!.result).resolves.toBe('first')
    expect(registry.size).toBe(MAX_AUTH_FILESYSTEM_REGISTRY_ENTRIES - 1)

    const recovered = registry.getOrCreate(
      '/auth/recovered',
      () => deferredReads[MAX_AUTH_FILESYSTEM_REGISTRY_ENTRIES]!.promise
    )
    expect(recovered).not.toBeNull()
    expect(registry.size).toBe(MAX_AUTH_FILESYSTEM_REGISTRY_ENTRIES)

    for (let index = 1; index < MAX_AUTH_FILESYSTEM_REGISTRY_ENTRIES; index += 1) {
      deferredReads[index]!.resolve(`read-${index}`)
    }
    deferredReads[MAX_AUTH_FILESYSTEM_REGISTRY_ENTRIES]!.resolve('recovered')
    await Promise.all([
      ...operations.slice(1).map((operation) => operation!.result),
      recovered!.result
    ])
    expect(registry.size).toBe(0)
  })

  it('accepts an exact-limit auth path and rejects one byte more without starting it', async () => {
    const exactPath = 'x'.repeat(MAX_AUTH_FILESYSTEM_OPERATION_PATH_BYTES)
    const exactRaw = vi.fn(async () => 'exact')
    const exact = createAuthFilesystemOperation(exactPath, exactRaw)
    const controller = new AbortController()

    await expect(exact.wait(controller.signal)).resolves.toBe('exact')
    expect(exactRaw).toHaveBeenCalledOnce()

    const oversizedRaw = vi.fn(async () => 'oversized')
    const oversized = createAuthFilesystemOperation(`${exactPath}x`, oversizedRaw)
    await expect(oversized.wait(controller.signal)).rejects.toBeInstanceOf(
      AuthFilesystemOperationLimitError
    )
    expect(oversizedRaw).not.toHaveBeenCalled()
  })

  it('caps coalesced waiters and admits another after one leaves', async () => {
    const read = deferred<string>()
    const operation = createAuthFilesystemOperation('/auth/shared', () => read.promise)
    const controllers = Array.from(
      { length: MAX_AUTH_FILESYSTEM_OPERATION_WAITERS },
      () => new AbortController()
    )
    const waits = controllers.map((controller) => operation.wait(controller.signal))

    await expect(operation.wait(new AbortController().signal)).rejects.toBeInstanceOf(
      AuthFilesystemOperationLimitError
    )

    const abandoned = new Error('first waiter left')
    controllers[0]!.abort(abandoned)
    await expect(waits[0]).rejects.toBe(abandoned)
    const recovered = operation.wait(new AbortController().signal)

    read.resolve('shared')
    await expect(recovered).resolves.toBe('shared')
    await expect(Promise.all(waits.slice(1))).resolves.toEqual(
      Array.from({ length: MAX_AUTH_FILESYSTEM_OPERATION_WAITERS - 1 }, () => 'shared')
    )
  })

  it('caps the WSL wait queue and recovers as soon as a queued operation leaves', async () => {
    const ubuntuRead = deferred<string>()
    const debianRead = deferred<string>()
    const ubuntuRaw = vi.fn(() => ubuntuRead.promise)
    const debianRaw = vi.fn(() => debianRead.promise)
    const activeController = new AbortController()
    const ubuntu = createAuthFilesystemOperation(
      '\\\\wsl$\\Ubuntu\\home\\alice\\auth.json',
      ubuntuRaw
    )
    const debian = createAuthFilesystemOperation(
      '\\\\wsl$\\Debian\\home\\alice\\auth.json',
      debianRaw
    )
    const ubuntuWait = ubuntu.wait(activeController.signal)
    const debianWait = debian.wait(activeController.signal)
    await Promise.resolve()
    await Promise.resolve()
    expect(ubuntuRaw).toHaveBeenCalledOnce()
    expect(debianRaw).toHaveBeenCalledOnce()

    const queuedControllers: AbortController[] = []
    const queuedWaits: Promise<string>[] = []
    for (let index = 0; index < MAX_QUEUED_WSL_AUTH_OPERATIONS; index += 1) {
      const controller = new AbortController()
      const operation = createAuthFilesystemOperation(
        `\\\\wsl$\\Queued-${index}\\home\\alice\\auth.json`,
        async () => `queued-${index}`
      )
      queuedControllers.push(controller)
      queuedWaits.push(operation.wait(controller.signal))
    }

    const overflowRaw = vi.fn(async () => 'overflow')
    const overflow = createAuthFilesystemOperation(
      '\\\\wsl$\\Overflow\\home\\alice\\auth.json',
      overflowRaw
    )
    await expect(overflow.wait(new AbortController().signal)).rejects.toBeInstanceOf(
      AuthFilesystemOperationLimitError
    )
    expect(overflowRaw).not.toHaveBeenCalled()

    const released = new Error('release queue slot')
    queuedControllers[0]!.abort(released)
    await expect(queuedWaits[0]).rejects.toBe(released)

    const recoveredController = new AbortController()
    const recoveredRaw = vi.fn(async () => 'recovered')
    const recovered = createAuthFilesystemOperation(
      '\\\\wsl$\\Recovered\\home\\alice\\auth.json',
      recoveredRaw
    )
    const recoveredWait = recovered.wait(recoveredController.signal)
    const recoveredAbort = new Error('recovered queue entry admitted')
    recoveredController.abort(recoveredAbort)
    await expect(recoveredWait).rejects.toBe(recoveredAbort)
    expect(recoveredRaw).not.toHaveBeenCalled()

    for (const controller of queuedControllers.slice(1)) {
      controller.abort(new Error('test cleanup'))
    }
    await Promise.allSettled(queuedWaits.slice(1))
    ubuntuRead.resolve('ubuntu')
    debianRead.resolve('debian')
    await expect(Promise.all([ubuntuWait, debianWait])).resolves.toEqual(['ubuntu', 'debian'])
  })
})
