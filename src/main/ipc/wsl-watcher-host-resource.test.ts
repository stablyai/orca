import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startWslWatcherHost } from './wsl-watcher-host-entry'
import { createWatcherHostResourceBudget } from './wsl-watcher-host-reconciliation'
import { watcherSafetyDelay } from './wsl-watcher-host-safety'

function checkpoint(snapshot = new Map()) {
  return { kind: 'complete' as const, snapshot }
}

function outputCapture(): { output: PassThrough; text: () => string } {
  const output = new PassThrough()
  let outputText = ''
  output.on('data', (chunk: Buffer) => {
    outputText += chunk.toString('utf8')
  })
  return { output, text: () => outputText }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('WSL watcher host aggregate resources', () => {
  it('reschedules resource contention without interrupting a healthy root', async () => {
    vi.useFakeTimers()
    const input = new PassThrough()
    const captured = outputCapture()
    const scan = vi
      .fn()
      .mockResolvedValueOnce(checkpoint())
      .mockResolvedValueOnce(checkpoint())
      .mockResolvedValueOnce({ kind: 'resource-limit' })
      .mockResolvedValue(checkpoint())
    startWslWatcherHost(
      { subscribe: vi.fn(async () => undefined), unsubscribe: vi.fn(async () => undefined) },
      input,
      captured.output,
      vi.fn(),
      scan
    )
    input.write(`${JSON.stringify({ op: 'subscribe', id: 20, dir: '/busy', ignoreDirs: [] })}\n`)
    await vi.waitFor(() => expect(captured.text()).toContain('"op":"subscribed","id":20'))
    await vi.advanceTimersByTimeAsync(watcherSafetyDelay('/busy', 0, 1))

    expect(scan).toHaveBeenCalledTimes(3)
    expect(captured.text()).not.toContain('"op":"watch-error"')
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    input.end()
  })

  it('recycles the host when a new native subscribe stalls beside a retained root', async () => {
    vi.useFakeTimers()
    const input = new PassThrough()
    const captured = outputCapture()
    const subscribe = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<void>(() => undefined))
    const exit = vi.fn()
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    startWslWatcherHost(
      { subscribe, unsubscribe: vi.fn(async () => undefined) } as never,
      input,
      captured.output,
      exit,
      async () => checkpoint(),
      createWatcherHostResourceBudget(),
      10
    )
    input.write(`${JSON.stringify({ op: 'subscribe', id: 21, dir: '/one', ignoreDirs: [] })}\n`)
    await vi.waitFor(() => expect(captured.text()).toContain('"op":"subscribed","id":21'))
    input.write(`${JSON.stringify({ op: 'subscribe', id: 22, dir: '/two', ignoreDirs: [] })}\n`)
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(10)

    expect(exit).toHaveBeenCalledWith(4)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('native subscribe did not settle'))
    input.end()
  })

  it('recycles the host when unsubscribe stalls while another root is retained', async () => {
    vi.useFakeTimers()
    const input = new PassThrough()
    const captured = outputCapture()
    const exit = vi.fn()
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const unsubscribe = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>(() => undefined))
      .mockResolvedValue(undefined)
    startWslWatcherHost(
      {
        subscribe: vi.fn(async () => undefined),
        unsubscribe
      } as never,
      input,
      captured.output,
      exit,
      async () => checkpoint(),
      createWatcherHostResourceBudget(),
      10
    )
    for (const id of [23, 24]) {
      input.write(`${JSON.stringify({ op: 'subscribe', id, dir: `/${id}`, ignoreDirs: [] })}\n`)
      await vi.waitFor(() => expect(captured.text()).toContain(`"op":"subscribed","id":${id}`))
    }
    input.write(`${JSON.stringify({ op: 'unsubscribe', id: 23 })}\n`)
    await vi.advanceTimersByTimeAsync(10)

    expect(exit).toHaveBeenCalledWith(4)
    input.end()
  })

  it('enforces and releases the host-wide snapshot budget across roots', async () => {
    const input = new PassThrough()
    const captured = outputCapture()
    const scan = vi.fn(async (root: string) =>
      checkpoint(new Map([[root, { directory: true, signature: `d:${root}` }]]))
    )
    startWslWatcherHost(
      {
        subscribe: vi.fn(async () => undefined),
        unsubscribe: vi.fn(async () => undefined)
      } as never,
      input,
      captured.output,
      vi.fn(),
      scan,
      createWatcherHostResourceBudget({ snapshotEntries: 1 })
    )
    input.write(`${JSON.stringify({ op: 'subscribe', id: 31, dir: '/one', ignoreDirs: [] })}\n`)
    await vi.waitFor(() => expect(captured.text()).toContain('"op":"subscribed","id":31'))
    input.write(`${JSON.stringify({ op: 'subscribe', id: 32, dir: '/two', ignoreDirs: [] })}\n`)
    await vi.waitFor(() => expect(captured.text()).toContain('"op":"watch-error","id":32'))
    expect(captured.text()).toContain('"reason":"topology"')

    input.write(`${JSON.stringify({ op: 'unsubscribe', id: 31 })}\n`)
    await vi.waitFor(() => expect(captured.text()).toContain('"op":"unsubscribed","id":31'))
    input.write(`${JSON.stringify({ op: 'subscribe', id: 33, dir: '/three', ignoreDirs: [] })}\n`)
    await vi.waitFor(() => expect(captured.text()).toContain('"op":"subscribed","id":33'))
    input.end()
  })

  it('uses aggregate pending and journal limits instead of per-root multiplication', () => {
    const budget = createWatcherHostResourceBudget({ pendingEvents: 2, journalEvents: 3 })
    expect(budget.reserve('pendingEvents', 2)).toBe(true)
    expect(budget.reserve('pendingEvents', 1)).toBe(false)
    budget.release('pendingEvents', 2)
    expect(budget.reserve('pendingEvents', 1)).toBe(true)
    expect(budget.reserve('journalEvents', 3)).toBe(true)
    expect(budget.reserve('journalEvents', 1)).toBe(false)
  })

  it('interrupts deterministically when roots exceed the aggregate pending-event cap', async () => {
    const input = new PassThrough()
    const captured = outputCapture()
    const callbacks: ((error: Error | null, events: unknown[]) => void)[] = []
    startWslWatcherHost(
      {
        subscribe: vi.fn(async (_dir, callback) => {
          callbacks.push(callback)
        }),
        unsubscribe: vi.fn(async () => undefined)
      } as never,
      input,
      captured.output,
      vi.fn(),
      async () => checkpoint(),
      createWatcherHostResourceBudget({ pendingEvents: 1 })
    )
    for (const id of [41, 42]) {
      input.write(`${JSON.stringify({ op: 'subscribe', id, dir: `/${id}`, ignoreDirs: [] })}\n`)
      await vi.waitFor(() => expect(captured.text()).toContain(`"op":"subscribed","id":${id}`))
    }

    callbacks[0]?.(null, [{ type: 'update', path: '/41/file' }])
    callbacks[1]?.(null, [{ type: 'update', path: '/42/file' }])

    expect(captured.text()).toContain('"op":"watch-error","id":42')
    expect(captured.text()).toContain('"reason":"topology"')
    input.end()
  })
})
