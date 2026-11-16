// Creates hung 180 s with no log and no row; the steps before the create log.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStepWatch } from '../src/index'

describe('create step watch', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('names a step still pending after 10 s, then reports every step once the create starts', async () => {
    vi.useFakeTimers()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const watch = createStepWatch(true, () => Date.now())
    let finish: (value: string) => void = () => undefined
    const body = watch.step('body', new Promise<string>((resolve) => (finish = resolve)))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"step":"body"'))
    finish('{}')
    await expect(body).resolves.toBe('{}')
    watch.done()
    watch.done()
    const reports = log.mock.calls.filter(([line]) => String(line).includes('"create_steps"'))
    expect(reports).toHaveLength(1)
    expect(String(reports[0]![0])).toContain('"body":10000')
  })

  it('stays quiet for other routes', async () => {
    vi.useFakeTimers()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const watch = createStepWatch(false)
    const pending = watch.step('auth', new Promise(() => undefined))
    await vi.advanceTimersByTimeAsync(20_000)
    watch.done()
    expect(log).not.toHaveBeenCalled()
    void pending
  })
})
