import { describe, expect, it, vi } from 'vitest'
import { runWslTranscriptFsTask } from './wsl-transcript-fs-gate'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  return {
    promise: new Promise<T>((res, rej) => ((resolve = res), (reject = rej))),
    resolve,
    reject
  }
}

function run(
  path: string,
  priority: 'exact' | 'scan',
  task: () => Promise<string>,
  signal?: AbortSignal
): Promise<string> {
  return runWslTranscriptFsTask(
    { operation: priority === 'exact' ? 'access' : 'readdir', path, priority, signal },
    task
  )
}

describe('WSL transcript filesystem task scheduling', () => {
  it('does not block an exact probe behind a running scan on the same route', async () => {
    const stalled = deferred<string>()
    const scanTask = vi.fn(() => stalled.promise)
    const scan = run('\\\\wsl.localhost\\Ubuntu\\tree', 'scan', scanTask)
    await vi.waitFor(() => expect(scanTask).toHaveBeenCalledOnce())

    await expect(
      run('\\\\wsl.localhost\\Ubuntu\\transcript.jsonl', 'exact', async () => 'exact')
    ).resolves.toBe('exact')
    stalled.resolve('scan')
    await expect(scan).resolves.toBe('scan')
  })

  it('allows healthy distros and provider routes to bypass a stalled lane', async () => {
    const stalled = deferred<string>()
    const ubuntuLocalhost = run('\\\\wsl.localhost\\Ubuntu\\home\\a', 'scan', () => stalled.promise)
    const debian = vi.fn(async () => 'debian')
    const ubuntuLegacy = vi.fn(async () => 'legacy')

    await expect(run('\\\\wsl.localhost\\Debian\\home\\a', 'exact', debian)).resolves.toBe('debian')
    await expect(run('\\\\wsl$\\Ubuntu\\home\\a', 'exact', ubuntuLegacy)).resolves.toBe('legacy')
    expect(debian).toHaveBeenCalledOnce()
    expect(ubuntuLegacy).toHaveBeenCalledOnce()

    stalled.resolve('localhost')
    await expect(ubuntuLocalhost).resolves.toBe('localhost')
  })

  it('runs an exact probe before older queued scan work', async () => {
    const ubuntu = deferred<string>()
    const debian = deferred<string>()
    const occupied: string[] = []
    const started: string[] = []
    const first = run('\\\\wsl.localhost\\Ubuntu\\a', 'exact', () => {
      occupied.push('ubuntu')
      return ubuntu.promise
    })
    const second = run('\\\\wsl.localhost\\Debian\\a', 'exact', () => {
      occupied.push('debian')
      return debian.promise
    })
    await vi.waitFor(() => expect(occupied).toEqual(['ubuntu', 'debian']))

    const scan = run('\\\\wsl.localhost\\Fedora\\tree', 'scan', async () => {
      started.push('scan')
      return 'scan'
    })
    const exact = run('\\\\wsl.localhost\\Fedora\\file', 'exact', async () => {
      started.push('exact')
      return 'exact'
    })

    debian.resolve('debian')
    await expect(exact).resolves.toBe('exact')
    expect(started).toEqual(['exact', 'scan'])
    await expect(scan).resolves.toBe('scan')
    ubuntu.resolve('ubuntu')
    await expect(Promise.all([first, second])).resolves.toEqual(['ubuntu', 'debian'])
  })

  it('drops abandoned queued work before it reaches the filesystem', async () => {
    const ubuntu = deferred<string>()
    const debian = deferred<string>()
    const first = run('\\\\wsl.localhost\\Ubuntu\\a', 'scan', () => ubuntu.promise)
    const second = run('\\\\wsl.localhost\\Debian\\a', 'scan', () => debian.promise)
    const controller = new AbortController()
    const abandonedTask = vi.fn(async () => 'unused')
    const abandoned = run('\\\\wsl.localhost\\Fedora\\a', 'scan', abandonedTask, controller.signal)

    controller.abort(new Error('closed subscription'))
    await expect(abandoned).rejects.toThrow('closed subscription')
    ubuntu.resolve('ubuntu')
    debian.resolve('debian')
    await Promise.all([first, second])
    expect(abandonedTask).not.toHaveBeenCalled()
  })

  it('shares only byte-identical requests', async () => {
    const firstTask = vi.fn(async () => 'first')
    const duplicateTask = vi.fn(async () => 'duplicate')
    const first = run('\\\\wsl.localhost\\Ubuntu\\home\\a', 'exact', firstTask)
    const duplicate = run('\\\\wsl.localhost\\Ubuntu\\home\\a', 'exact', duplicateTask)

    await expect(Promise.all([first, duplicate])).resolves.toEqual(['first', 'first'])
    expect(firstTask).toHaveBeenCalledOnce()
    expect(duplicateTask).not.toHaveBeenCalled()
  })

  it('keeps shared work needed by a remaining waiter', async () => {
    const pending = deferred<string>()
    const task = vi.fn(() => pending.promise)
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = run('\\\\wsl.localhost\\Ubuntu\\shared', 'exact', task, firstController.signal)
    const second = run('\\\\wsl.localhost\\Ubuntu\\shared', 'exact', task, secondController.signal)
    await vi.waitFor(() => expect(task).toHaveBeenCalledOnce())

    firstController.abort(new Error('first closed'))
    await expect(first).rejects.toThrow('first closed')
    pending.resolve('second')
    await expect(second).resolves.toBe('second')
    expect(task).toHaveBeenCalledOnce()
  })

  it('does not attach new callers to abandoned running work', async () => {
    const stalled = deferred<string>()
    const firstTask = vi.fn(() => stalled.promise)
    const firstController = new AbortController()
    const first = run(
      '\\\\wsl.localhost\\Ubuntu\\abandoned',
      'exact',
      firstTask,
      firstController.signal
    )
    await vi.waitFor(() => expect(firstTask).toHaveBeenCalledOnce())

    firstController.abort(new Error('first closed'))
    await expect(first).rejects.toThrow('first closed')
    const replacementWork = deferred<string>()
    const replacementTask = vi.fn(() => replacementWork.promise)
    const replacement = run('\\\\wsl.localhost\\Ubuntu\\abandoned', 'exact', replacementTask)

    stalled.resolve('abandoned')
    await vi.waitFor(() => expect(replacementTask).toHaveBeenCalledOnce())
    const duplicateTask = vi.fn(async () => 'duplicate')
    const duplicate = run('\\\\wsl.localhost\\Ubuntu\\abandoned', 'exact', duplicateTask)
    replacementWork.resolve('replacement')

    await expect(Promise.all([replacement, duplicate])).resolves.toEqual([
      'replacement',
      'replacement'
    ])
    expect(replacementTask).toHaveBeenCalledOnce()
    expect(duplicateTask).not.toHaveBeenCalled()
  })

  it('does not conflate provider aliases or Linux path case', async () => {
    const paths = [
      '\\\\wsl.localhost\\Ubuntu\\home\\a',
      '\\\\wsl$\\Ubuntu\\home\\a',
      '\\\\wsl.localhost\\Ubuntu\\mnt\\C\\a',
      '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\a'
    ]
    const tasks = paths.map((path, index) => run(path, 'exact', async () => String(index)))

    await expect(Promise.all(tasks)).resolves.toEqual(['0', '1', '2', '3'])
  })
})
