import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { buildIgnoreGlobs, startWslWatcherHost } from './wsl-watcher-host-entry'
import {
  watcherSafetyDelay,
  type SafetyScanResult,
  type SafetySnapshot
} from './wsl-watcher-host-safety'

function checkpoint(snapshot: SafetySnapshot) {
  return { kind: 'complete' as const, snapshot }
}

describe('WSL watcher Linux host', () => {
  it('builds nested directory exclusions without treating names as regex', () => {
    const [nodeModules, dotted] = buildIgnoreGlobs(['node_modules', '.cache'])

    expect(nodeModules).toBe('^(?:.*/)?node_modules(?:/.*)?$')
    expect(dotted).toBe('^(?:.*/)?\\.cache(?:/.*)?$')
    expect(new RegExp(nodeModules!).test('/repo/packages/app/node_modules/pkg/file.js')).toBe(true)
    expect(new RegExp(dotted!).test('/repo/.cache/item')).toBe(true)
  })

  it('multiplexes subscriptions and native events over JSON lines', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let outputText = ''
    output.on('data', (chunk: Buffer) => {
      outputText += chunk.toString('utf8')
    })
    let callback: ((error: Error | null, events: unknown[]) => void) | undefined
    const subscribe = vi.fn(async (_dir, createdCallback) => {
      callback = createdCallback
    })
    const unsubscribe = vi.fn(async () => undefined)
    const exit = vi.fn()
    startWslWatcherHost({ subscribe, unsubscribe } as never, input, output, exit)

    expect(outputText).toContain('"op":"ready"')
    input.write(
      `${JSON.stringify({
        op: 'subscribe',
        id: 7,
        dir: '/home/me/repo',
        ignoreDirs: ['node_modules']
      })}\n`
    )
    await vi.waitFor(() => expect(outputText).toContain('"op":"subscribed","id":7'))
    expect(subscribe).toHaveBeenCalledWith('/home/me/repo', expect.any(Function), {
      ignoreGlobs: ['^(?:.*/)?node_modules(?:/.*)?$']
    })

    callback?.(null, [{ type: 'update', path: '/home/me/repo/README.md' }])
    await vi.waitFor(() => expect(outputText).toContain('"op":"events","id":7'))
    input.write(`${JSON.stringify({ op: 'unsubscribe', id: 7 })}\n`)
    await vi.waitFor(() => expect(outputText).toContain('"op":"unsubscribed","id":7'))
    expect(unsubscribe).toHaveBeenCalledOnce()

    input.end()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
  })

  it('rejects malformed commands without invoking the native binding', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let outputText = ''
    output.on('data', (chunk: Buffer) => {
      outputText += chunk.toString('utf8')
    })
    const subscribe = vi.fn()
    startWslWatcherHost({ subscribe, unsubscribe: vi.fn() } as never, input, output, vi.fn())

    input.write('{not-json}\n')
    await vi.waitFor(() => expect(outputText).toContain('"op":"protocol-error"'))
    expect(subscribe).not.toHaveBeenCalled()
    input.end()
  })

  it('turns watched-root deletion into a recoverable interruption', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let outputText = ''
    output.on('data', (chunk: Buffer) => {
      outputText += chunk.toString('utf8')
    })
    let callback: ((error: Error | null, events: never[]) => void) | undefined
    const subscribe = vi.fn(async (_dir, createdCallback) => {
      callback = createdCallback
    })
    startWslWatcherHost(
      { subscribe, unsubscribe: vi.fn(async () => undefined) } as never,
      input,
      output,
      vi.fn()
    )
    input.write(
      `${JSON.stringify({ op: 'subscribe', id: 9, dir: '/missing/repo', ignoreDirs: [] })}\n`
    )
    await vi.waitFor(() => expect(outputText).toContain('"op":"subscribed","id":9'))

    callback?.(null, [{ type: 'delete', path: '/missing/repo' }] as never)

    await vi.waitFor(() => expect(outputText).toContain('"op":"watch-error","id":9'))
    input.end()
  })

  it('marks attach-window topology failures for a retained overflow restart', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let outputText = ''
    output.on('data', (chunk: Buffer) => {
      outputText += chunk.toString('utf8')
    })
    const before = new Map([['/repo', { directory: true, signature: 'd:1' }]])
    const after = new Map([
      ['/repo', { directory: true, signature: 'd:1' }],
      ['/repo/imported', { directory: true, signature: 'd:2' }]
    ])
    const scan = vi
      .fn()
      .mockResolvedValueOnce(checkpoint(before))
      .mockResolvedValueOnce(checkpoint(after))
    startWslWatcherHost(
      { subscribe: vi.fn(async () => undefined), unsubscribe: vi.fn(async () => undefined) },
      input,
      output,
      vi.fn(),
      scan
    )

    input.write(`${JSON.stringify({ op: 'subscribe', id: 10, dir: '/repo', ignoreDirs: [] })}\n`)
    await vi.waitFor(() => expect(outputText).toContain('"op":"watch-error","id":10'))

    expect(outputText).toContain('"reason":"topology"')
    expect(outputText).not.toContain('"op":"subscribed","id":10')
    input.end()
  })

  it('reconciles mutations across native attachment before reporting ready', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let outputText = ''
    output.on('data', (chunk: Buffer) => {
      outputText += chunk.toString('utf8')
    })
    const before = new Map([
      ['/repo', { directory: true, signature: 'd:1' }],
      ['/repo/file', { directory: false, signature: 'f:before' }]
    ])
    const after = new Map([
      ['/repo', { directory: true, signature: 'd:1' }],
      ['/repo/file', { directory: false, signature: 'f:after' }]
    ])
    const scan = vi
      .fn()
      .mockResolvedValueOnce(checkpoint(before))
      .mockResolvedValueOnce(checkpoint(after))
    startWslWatcherHost(
      { subscribe: vi.fn(async () => undefined), unsubscribe: vi.fn(async () => undefined) },
      input,
      output,
      vi.fn(),
      scan
    )

    input.write(`${JSON.stringify({ op: 'subscribe', id: 11, dir: '/repo', ignoreDirs: [] })}\n`)
    await vi.waitFor(() => expect(outputText).toContain('"op":"subscribed","id":11'))

    const eventIndex = outputText.indexOf('"op":"events","id":11')
    expect(eventIndex).toBeGreaterThan(-1)
    expect(eventIndex).toBeLessThan(outputText.indexOf('"op":"subscribed","id":11'))
    input.end()
  })

  it('cancels an abandoned initial checkpoint before attaching native watching', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let outputText = ''
    output.on('data', (chunk: Buffer) => {
      outputText += chunk.toString('utf8')
    })
    const subscribe = vi.fn()
    const scan = vi.fn((_root, _ignored, options) => {
      return new Promise<SafetyScanResult>((resolve) => {
        options.signal.addEventListener('abort', () => resolve({ kind: 'cancelled' }), {
          once: true
        })
      })
    })
    startWslWatcherHost({ subscribe, unsubscribe: vi.fn() } as never, input, output, vi.fn(), scan)
    input.write(`${JSON.stringify({ op: 'subscribe', id: 12, dir: '/repo', ignoreDirs: [] })}\n`)
    await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce())
    input.write(`${JSON.stringify({ op: 'unsubscribe', id: 12 })}\n`)
    await vi.waitFor(() => expect(outputText).toContain('"op":"unsubscribed","id":12'))

    expect(subscribe).not.toHaveBeenCalled()
    input.end()
  })

  it('finishes reconciliation under sustained native traffic', async () => {
    vi.useFakeTimers()
    const input = new PassThrough()
    const output = new PassThrough()
    let outputText = ''
    output.on('data', (chunk: Buffer) => {
      outputText += chunk.toString('utf8')
    })
    let callback: (error: Error | null, events: { type: 'update'; path: string }[]) => void
    let finishPeriodic!: (value: ReturnType<typeof checkpoint>) => void
    const empty = new Map()
    const scan = vi
      .fn()
      .mockResolvedValueOnce(checkpoint(empty))
      .mockResolvedValueOnce(checkpoint(empty))
      .mockImplementationOnce(
        () => new Promise((resolve) => (finishPeriodic = resolve as typeof finishPeriodic))
      )
      .mockResolvedValue(checkpoint(empty))
    startWslWatcherHost(
      {
        subscribe: vi.fn(async (_dir, createdCallback) => {
          callback = createdCallback
        }),
        unsubscribe: vi.fn(async () => undefined)
      } as never,
      input,
      output,
      vi.fn(),
      scan
    )
    input.write(`${JSON.stringify({ op: 'subscribe', id: 13, dir: '/busy', ignoreDirs: [] })}\n`)
    await vi.waitFor(() => expect(outputText).toContain('"op":"subscribed","id":13'))
    await vi.advanceTimersByTimeAsync(watcherSafetyDelay('/busy', 0, 1))
    expect(scan).toHaveBeenCalledTimes(3)

    for (let index = 0; index < 100; index += 1) {
      callback!(null, [{ type: 'update', path: `/busy/file-${index}` }])
    }
    finishPeriodic(checkpoint(empty))
    await vi.advanceTimersByTimeAsync(0)

    expect(outputText).not.toContain('"op":"watch-error","id":13')
    expect(scan).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
    input.end()
  })
})
