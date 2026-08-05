import { describe, expect, it, vi } from 'vitest'
import {
  AI_VAULT_DIRECT_SSH_SCAN_CONCURRENCY,
  mapDirectSshScans
} from './remote-session-scan-concurrency'

describe('mapDirectSshScans', () => {
  it('caps concurrent scans and preserves input ordering', async () => {
    let active = 0
    let maximum = 0
    const result = await mapDirectSshScans(
      Array.from({ length: 12 }, (_, index) => index),
      async (value) => {
        active++
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, (value % 3) + 1))
        active--
        return value * 2
      },
      new AbortController().signal
    )

    expect(maximum).toBe(AI_VAULT_DIRECT_SSH_SCAN_CONCURRENCY)
    expect(result).toEqual(Array.from({ length: 12 }, (_, index) => index * 2))
  })

  it('does not start queued scans after cancellation', async () => {
    const controller = new AbortController()
    const releases: (() => void)[] = []
    const started: number[] = []
    const pending = mapDirectSshScans(
      Array.from({ length: 8 }, (_, index) => index),
      async (value) => {
        started.push(value)
        await new Promise<void>((resolve) => releases.push(resolve))
        return value
      },
      controller.signal
    )
    await vi.waitFor(() => expect(started).toHaveLength(AI_VAULT_DIRECT_SSH_SCAN_CONCURRENCY))

    controller.abort()
    releases.splice(0).forEach((release) => release())

    await expect(pending).rejects.toThrow('ai_vault_scan_cancelled')
    expect(started).toHaveLength(AI_VAULT_DIRECT_SSH_SCAN_CONCURRENCY)
  })
})
