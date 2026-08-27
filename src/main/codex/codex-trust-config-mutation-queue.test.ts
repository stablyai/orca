import { describe, expect, it } from 'vitest'
import { runExclusivelyForCodexTrustConfig } from './codex-trust-config-mutation-queue'

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('runExclusivelyForCodexTrustConfig', () => {
  // Why: the grant lane runs inside the installer that already owns the file;
  // a non-reentrant lane would queue it behind itself and never settle.
  it('passes through a nested acquire of a lane the caller already holds', async () => {
    const nested = await runExclusivelyForCodexTrustConfig('/a/config.toml', () =>
      runExclusivelyForCodexTrustConfig('/a/config.toml', () => Promise.resolve('inner'))
    )
    expect(nested).toBe('inner')
  })

  it('still queues an unrelated lane acquired from inside another lane', async () => {
    const gate = deferred()
    let innerRan = false
    const blocking = runExclusivelyForCodexTrustConfig('/b/config.toml', () => gate.promise)
    const nested = runExclusivelyForCodexTrustConfig('/a/config.toml', () =>
      runExclusivelyForCodexTrustConfig('/b/config.toml', () => {
        innerRan = true
        return Promise.resolve()
      })
    )
    await Promise.resolve()
    expect(innerRan).toBe(false)
    gate.resolve()
    await blocking
    await nested
    expect(innerRan).toBe(true)
  })

  it('runs one mutation at a time per config.toml', async () => {
    const order: string[] = []
    const first = deferred()
    const second = deferred()

    const a = runExclusivelyForCodexTrustConfig('/home/.codex/config.toml', async () => {
      order.push('a:start')
      await first.promise
      order.push('a:end')
      return 'a'
    })
    const b = runExclusivelyForCodexTrustConfig('/home/.codex/config.toml', async () => {
      order.push('b:start')
      await second.promise
      order.push('b:end')
      return 'b'
    })

    await Promise.resolve()
    expect(order).toEqual(['a:start'])
    first.resolve()
    await a
    second.resolve()
    await b
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  it('keeps distinct config.toml paths independent', async () => {
    const gate = deferred()
    let secondRan = false
    const blocked = runExclusivelyForCodexTrustConfig('/a/config.toml', () => gate.promise)
    await runExclusivelyForCodexTrustConfig('/b/config.toml', async () => {
      secondRan = true
    })
    expect(secondRan).toBe(true)
    gate.resolve()
    await blocked
  })

  it('keeps the queue alive after a rejected mutation', async () => {
    const failing = runExclusivelyForCodexTrustConfig('/a/config.toml', () =>
      Promise.reject(new Error('grant blew up'))
    )
    await expect(failing).rejects.toThrow('grant blew up')
    await expect(
      runExclusivelyForCodexTrustConfig('/a/config.toml', () => Promise.resolve('next'))
    ).resolves.toBe('next')
  })

  // Why: normalized keys, so a Windows caller passing the other separator or
  // case must still land in the same lane as the run it has to wait for.
  it('serializes equivalent paths that differ only in normalization', async () => {
    const gate = deferred()
    let secondStarted = false
    const blocked = runExclusivelyForCodexTrustConfig(
      String.raw`C:\Users\Alice\.codex\config.toml`,
      () => gate.promise
    )
    const queued = runExclusivelyForCodexTrustConfig('C:/Users/Alice/.codex/config.toml', () => {
      secondStarted = true
      return Promise.resolve()
    })
    await Promise.resolve()
    expect(secondStarted).toBe(false)
    gate.resolve()
    await blocked
    await queued
    expect(secondStarted).toBe(true)
  })
})
