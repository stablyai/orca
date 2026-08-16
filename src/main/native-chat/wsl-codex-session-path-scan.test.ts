import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ walk: vi.fn() }))

vi.mock('../ai-vault/session-scanner-discovery', () => ({
  walkSessionFiles: mocks.walk
}))

import { findWslCodexSessionPath } from './wsl-codex-session-path-scan'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((res) => (resolve = res)), resolve }
}

beforeEach(() => {
  mocks.walk.mockReset()
})

describe('WSL Codex session path scans', () => {
  it('shares one root snapshot across concurrent session ids', async () => {
    const scan = deferred<string[]>()
    let filePredicate: ((path: string) => boolean) | undefined
    mocks.walk.mockImplementation(
      (
        _root: string,
        _agent: string,
        _issues: unknown[],
        options: { filePredicate?: (path: string) => boolean }
      ) => {
        filePredicate = options.filePredicate
        return scan.promise
      }
    )

    const first = findWslCodexSessionPath('\\\\wsl.localhost\\Ubuntu\\sessions', 'first')
    const second = findWslCodexSessionPath('\\\\wsl.localhost\\Ubuntu\\sessions', 'second')
    const candidates = [
      '\\\\wsl.localhost\\Ubuntu\\sessions\\rollout-first.jsonl',
      '\\\\wsl.localhost\\Ubuntu\\sessions\\rollout-second.jsonl',
      '\\\\wsl.localhost\\Ubuntu\\sessions\\rollout-unrelated.jsonl'
    ]
    scan.resolve(candidates.filter((path) => filePredicate?.(path)))

    await expect(Promise.all([first, second])).resolves.toEqual([
      '\\\\wsl.localhost\\Ubuntu\\sessions\\rollout-first.jsonl',
      '\\\\wsl.localhost\\Ubuntu\\sessions\\rollout-second.jsonl'
    ])
    expect(mocks.walk).toHaveBeenCalledOnce()
    expect(filePredicate?.(candidates[2])).toBe(false)
  })

  it('refreshes a shared miss so post-start file creation is visible', async () => {
    const initial = deferred<string[]>()
    mocks.walk
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValueOnce(['\\\\wsl.localhost\\Ubuntu\\sessions\\2026\\rollout-created.jsonl'])

    const initialCaller = findWslCodexSessionPath('\\\\wsl.localhost\\Ubuntu\\sessions', 'absent')
    const laterCaller = findWslCodexSessionPath('\\\\wsl.localhost\\Ubuntu\\sessions', 'created')
    initial.resolve([])

    await expect(initialCaller).resolves.toBeNull()
    await expect(laterCaller).resolves.toBe(
      '\\\\wsl.localhost\\Ubuntu\\sessions\\2026\\rollout-created.jsonl'
    )
    expect(mocks.walk).toHaveBeenCalledTimes(2)
  })

  it('aborts an abandoned scan when its final waiter closes', async () => {
    let scanSignal: AbortSignal | undefined
    mocks.walk.mockImplementation(
      (_root: string, _agent: string, _issues: unknown[], options: { signal?: AbortSignal }) => {
        scanSignal = options.signal
        return new Promise<string[]>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true
          })
        })
      }
    )
    const controller = new AbortController()
    const scan = findWslCodexSessionPath(
      '\\\\wsl.localhost\\Ubuntu\\sessions',
      'closed',
      controller.signal
    )
    await vi.waitFor(() => expect(mocks.walk).toHaveBeenCalledOnce())

    controller.abort(new Error('closed'))
    await expect(scan).rejects.toThrow('closed')
    expect(scanSignal?.aborted).toBe(true)
  })

  it('does not attach new callers to an abandoned scan', async () => {
    const abandoned = deferred<string[]>()
    const replacementScan = deferred<string[]>()
    const replacementPath = '\\\\wsl.localhost\\Ubuntu\\sessions\\rollout-replacement.jsonl'
    mocks.walk.mockReturnValueOnce(abandoned.promise).mockReturnValueOnce(replacementScan.promise)
    const controller = new AbortController()
    const first = findWslCodexSessionPath(
      '\\\\wsl.localhost\\Ubuntu\\sessions',
      'first',
      controller.signal
    )
    await vi.waitFor(() => expect(mocks.walk).toHaveBeenCalledOnce())

    controller.abort(new Error('closed'))
    await expect(first).rejects.toThrow('closed')
    const replacement = findWslCodexSessionPath(
      '\\\\wsl.localhost\\Ubuntu\\sessions',
      'replacement'
    )
    await vi.waitFor(() => expect(mocks.walk).toHaveBeenCalledTimes(2))

    abandoned.resolve([])
    await Promise.resolve()
    await Promise.resolve()
    const duplicate = findWslCodexSessionPath('\\\\wsl.localhost\\Ubuntu\\sessions', 'replacement')
    replacementScan.resolve([replacementPath])

    await expect(Promise.all([replacement, duplicate])).resolves.toEqual([
      replacementPath,
      replacementPath
    ])
    expect(mocks.walk).toHaveBeenCalledTimes(2)
  })

  it('removes canceled joiners from a scan that still has an active waiter', async () => {
    const scan = deferred<string[]>()
    const scanThen = vi.spyOn(scan.promise, 'then')
    let filePredicate: ((path: string) => boolean) | undefined
    mocks.walk.mockImplementation(
      (
        _root: string,
        _agent: string,
        _issues: unknown[],
        options: { filePredicate?: (path: string) => boolean }
      ) => {
        filePredicate = options.filePredicate
        return scan.promise
      }
    )
    const root = '\\\\wsl.localhost\\Ubuntu\\sessions'
    const keeperPath = `${root}\\rollout-keeper.jsonl`
    const keeper = findWslCodexSessionPath(root, 'keeper')
    const initialThenCount = scanThen.mock.calls.length
    const duplicateController = new AbortController()
    const duplicate = findWslCodexSessionPath(root, 'keeper', duplicateController.signal)
    const uniqueCanceled = Array.from({ length: 256 }, (_, index) => {
      const controller = new AbortController()
      return {
        controller,
        path: `${root}\\rollout-canceled-${index}.jsonl`,
        promise: findWslCodexSessionPath(root, `canceled-${index}`, controller.signal)
      }
    })
    const canceledResults = Promise.allSettled([
      duplicate,
      ...uniqueCanceled.map(({ promise }) => promise)
    ])

    duplicateController.abort(new Error('duplicate closed'))
    for (const { controller } of uniqueCanceled) {
      controller.abort(new Error('joiner closed'))
    }

    const results = await canceledResults
    expect(results.every(({ status }) => status === 'rejected')).toBe(true)
    expect(scanThen).toHaveBeenCalledTimes(initialThenCount)
    expect(filePredicate?.(keeperPath)).toBe(true)
    expect(uniqueCanceled.every(({ path }) => filePredicate?.(path) === false)).toBe(true)

    const candidates = [keeperPath, ...uniqueCanceled.map(({ path }) => path)]
    scan.resolve(candidates.filter((path) => filePredicate?.(path)))

    await expect(keeper).resolves.toBe(keeperPath)
    expect(mocks.walk).toHaveBeenCalledOnce()
  })
})
