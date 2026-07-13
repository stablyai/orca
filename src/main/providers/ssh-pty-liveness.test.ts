import { describe, expect, it, vi } from 'vitest'
import { JsonRpcErrorCode } from '../ssh/relay-protocol'
import { SshPtyLiveness } from './ssh-pty-liveness'

function methodNotFound(): Error & { code: number } {
  return Object.assign(new Error('Method not found'), { code: JsonRpcErrorCode.MethodNotFound })
}

describe('SshPtyLiveness', () => {
  it('clears transient legacy overrides after an inventory rejection', async () => {
    let rejectInventory = (_error: Error): void => {}
    const listIds = vi.fn(
      () =>
        new Promise<string[]>((_resolve, reject) => {
          rejectInventory = reject
        })
    )
    const liveness = new SshPtyLiveness({
      probe: vi.fn().mockRejectedValue(methodNotFound()),
      listIds
    })
    const checking = liveness.hasPty('pty-probe')
    await vi.waitFor(() => expect(listIds).toHaveBeenCalledTimes(1))

    for (let index = 0; index < 100; index += 1) {
      liveness.markStopped(`pty-${index}`)
    }
    rejectInventory(new Error('connection lost'))
    await expect(checking).rejects.toThrow('connection lost')

    expect(
      (liveness as unknown as { legacyMembershipOverrides: Map<string, boolean> })
        .legacyMembershipOverrides.size
    ).toBe(0)
  })

  it('bounds override growth and invalidates the in-flight legacy snapshot', async () => {
    let resolveInventory = (_ids: string[]): void => {}
    const listIds = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          resolveInventory = resolve
        })
    )
    const liveness = new SshPtyLiveness({
      probe: vi.fn().mockRejectedValue(methodNotFound()),
      listIds
    })
    const checking = liveness.hasPty('pty-probe')
    await vi.waitFor(() => expect(listIds).toHaveBeenCalledTimes(1))

    for (let index = 0; index < 10_000; index += 1) {
      liveness.markStopped(`pty-${index}`)
    }
    expect(
      (liveness as unknown as { legacyMembershipOverrides: Map<string, boolean> })
        .legacyMembershipOverrides.size
    ).toBe(0)

    resolveInventory([])
    await expect(checking).rejects.toThrow(
      'SSH legacy PTY inventory invalidated during liveness updates'
    )
  })
})
