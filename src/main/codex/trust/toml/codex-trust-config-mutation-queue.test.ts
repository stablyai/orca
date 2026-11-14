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
  it('passes through a nested acquire of a lane the caller already holds', async () => {
    const nested = await runExclusivelyForCodexTrustConfig('/a/config.toml', () =>
      runExclusivelyForCodexTrustConfig('/a/config.toml', () => Promise.resolve('inner'))
    )
    expect(nested).toBe('inner')
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

  it('coalesces WSL UNC aliases without folding the case-sensitive Linux path', async () => {
    const aliasGate = deferred()
    let aliasStarted = false
    const blockedAlias = runExclusivelyForCodexTrustConfig(
      String.raw`\\wsl.localhost\Ubuntu\home\Alice\.codex\config.toml`,
      () => aliasGate.promise
    )
    const queuedAlias = runExclusivelyForCodexTrustConfig(
      String.raw`\\wsl$\ubuntu\home\Alice\.codex\config.toml`,
      () => {
        aliasStarted = true
        return Promise.resolve()
      }
    )
    await Promise.resolve()
    expect(aliasStarted).toBe(false)

    let distinctStarted = false
    await runExclusivelyForCodexTrustConfig(
      String.raw`\\wsl.localhost\Ubuntu\home\alice\.codex\config.toml`,
      async () => {
        distinctStarted = true
      }
    )
    expect(distinctStarted).toBe(true)

    aliasGate.resolve()
    await blockedAlias
    await queuedAlias
    expect(aliasStarted).toBe(true)
  })
})
