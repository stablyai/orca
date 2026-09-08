import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWslRelayIdentityReader } from './wsl-relay-identity-reader'
import type { WslRelayIdentityResult } from '../../shared/wsl-hook-relay-contract'

describe('wsl relay identity reader cost invariant', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports host cache age in addition to the relay capture age', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const readProcessIdentity = vi.fn().mockResolvedValue([
      {
        status: 'unverifiable' as const,
        reason: 'capture_failed',
        capturedAgeMs: 10
      }
    ])
    const reader = createWslRelayIdentityReader({ readProcessIdentity })
    const anchor = {
      distro: 'Ubuntu',
      bootId: '11111111-1111-1111-1111-111111111111',
      shellPid: 1,
      shellStartTime: 1,
      tty: '/dev/pts/1'
    }

    await expect(reader.read('Ubuntu', anchor)).resolves.toMatchObject({ capturedAgeMs: 10 })
    vi.setSystemTime(250)
    await expect(reader.read('Ubuntu', anchor)).resolves.toMatchObject({ capturedAgeMs: 260 })
    expect(readProcessIdentity).toHaveBeenCalledOnce()
  })

  it('keeps inventory reads stable until a PTY event resets the cache', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const readProcessIdentity = vi.fn().mockResolvedValue([
      {
        status: 'live' as const,
        processName: 'claude',
        anchor: {
          distro: 'Ubuntu',
          bootId: '11111111-1111-1111-1111-111111111111',
          shellPid: 1,
          shellStartTime: 1,
          tty: '/dev/pts/1'
        },
        capturedAgeMs: 0
      }
    ])
    const reader = createWslRelayIdentityReader({ readProcessIdentity })
    const anchor = {
      distro: 'Ubuntu',
      bootId: '11111111-1111-1111-1111-111111111111',
      shellPid: 1,
      shellStartTime: 1,
      tty: '/dev/pts/1'
    }

    await reader.readBatch('Ubuntu', [anchor], { stableUntilReset: true })
    vi.setSystemTime(60_000)
    await reader.readBatch('Ubuntu', [anchor], { stableUntilReset: true })
    expect(readProcessIdentity).toHaveBeenCalledOnce()

    reader.reset()
    await reader.readBatch('Ubuntu', [anchor], { stableUntilReset: true })
    expect(readProcessIdentity).toHaveBeenCalledTimes(2)
  })

  it('coalesces list-session bursts and reuses the capture until reset', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const readProcessIdentity = vi.fn().mockResolvedValue([
      {
        status: 'live' as const,
        processName: 'claude',
        anchor: {
          distro: 'Ubuntu',
          bootId: '11111111-1111-1111-1111-111111111111',
          shellPid: 1,
          shellStartTime: 1,
          tty: '/dev/pts/1'
        },
        capturedAgeMs: 0
      }
    ])
    const reader = createWslRelayIdentityReader({ readProcessIdentity })
    const anchor = {
      distro: 'Ubuntu',
      bootId: '11111111-1111-1111-1111-111111111111',
      shellPid: 1,
      shellStartTime: 1,
      tty: '/dev/pts/1'
    }

    await Promise.all(
      Array.from({ length: 5 }, () =>
        reader.readBatch('Ubuntu', [anchor], { stableUntilReset: true })
      )
    )
    expect(readProcessIdentity).toHaveBeenCalledOnce()

    vi.setSystemTime(60_000)
    await Promise.all(
      Array.from({ length: 5 }, () =>
        reader.readBatch('Ubuntu', [anchor], { stableUntilReset: true })
      )
    )
    expect(readProcessIdentity).toHaveBeenCalledOnce()

    reader.reset()
    await reader.readBatch('Ubuntu', [anchor], { stableUntilReset: true })
    expect(readProcessIdentity).toHaveBeenCalledTimes(2)
  })

  it('does not republish an in-flight capture after an event reset', async () => {
    let resolveCapture!: (result: WslRelayIdentityResult[]) => void
    const replacementResult: WslRelayIdentityResult[] = [
      {
        status: 'live',
        processName: 'claude',
        anchor: {
          distro: 'Ubuntu',
          bootId: '11111111-1111-1111-1111-111111111111',
          shellPid: 1,
          shellStartTime: 1,
          tty: '/dev/pts/1'
        },
        capturedAgeMs: 0
      }
    ]
    const readProcessIdentity = vi.fn(
      () =>
        new Promise<WslRelayIdentityResult[]>((resolve) => {
          resolveCapture = resolve
        })
    )
    const reader = createWslRelayIdentityReader({ readProcessIdentity })
    const anchor = {
      distro: 'Ubuntu',
      bootId: '11111111-1111-1111-1111-111111111111',
      shellPid: 1,
      shellStartTime: 1,
      tty: '/dev/pts/1'
    }
    const first = reader.readBatch('Ubuntu', [anchor], { stableUntilReset: true })
    expect(readProcessIdentity).toHaveBeenCalledOnce()
    reader.reset()
    resolveCapture(replacementResult)
    await first

    const second = reader.readBatch('Ubuntu', [anchor], { stableUntilReset: true })
    // The second request is intentionally independent of the stale first one.
    resolveCapture(replacementResult)
    await second
    expect(readProcessIdentity).toHaveBeenCalledTimes(2)
  })

  it('keeps a stable snapshot marked stable after a foreground read', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const readProcessIdentity = vi.fn().mockResolvedValue([
      {
        status: 'live' as const,
        processName: 'claude',
        anchor: {
          distro: 'Ubuntu',
          bootId: '11111111-1111-1111-1111-111111111111',
          shellPid: 1,
          shellStartTime: 1,
          tty: '/dev/pts/1'
        },
        capturedAgeMs: 0
      }
    ])
    const reader = createWslRelayIdentityReader({ readProcessIdentity })
    const anchor = {
      distro: 'Ubuntu',
      bootId: '11111111-1111-1111-1111-111111111111',
      shellPid: 1,
      shellStartTime: 1,
      tty: '/dev/pts/1'
    }

    await reader.readBatch('Ubuntu', [anchor], { stableUntilReset: true })
    vi.setSystemTime(60_000)
    await reader.readBatch('Ubuntu', [anchor])
    vi.setSystemTime(120_000)
    await reader.readBatch('Ubuntu', [anchor], { stableUntilReset: true })
    expect(readProcessIdentity).toHaveBeenCalledTimes(2)
    vi.setSystemTime(180_000)
    await reader.readBatch('Ubuntu', [anchor], { stableUntilReset: true })
    expect(readProcessIdentity).toHaveBeenCalledTimes(2)
  })
})
