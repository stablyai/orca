import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSetupCompletionScanner } from './setup-completion-signal'
import { bindSetupRunToPty, createSetupRun, type SetupRunOutcome } from '../setup/setup-run'
import type * as EndpointLoss from '../terminal/pty-endpoint-loss-signal'

// Counts live endpoint-loss subscriptions, the one listener a bound run holds outside its host.
const endpointLoss = vi.hoisted(() => ({ live: 0 }))
vi.mock('../terminal/pty-endpoint-loss-signal', async (importOriginal) => {
  const actual = await importOriginal<typeof EndpointLoss>()
  return {
    ...actual,
    subscribeToPtyEndpointLoss: (ptyId: string, listener: () => void) => {
      const unsubscribe = actual.subscribeToPtyEndpointLoss(ptyId, listener)
      endpointLoss.live += 1
      return () => {
        endpointLoss.live -= 1
        unsubscribe()
      }
    }
  }
})
const { publishPtyEndpointLoss } = await import('../terminal/pty-endpoint-loss-signal')

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('orchestration setup completion signal', () => {
  it('recognizes one completion signal across output chunk boundaries', () => {
    const onComplete = vi.fn()
    const scanner = createSetupCompletionScanner('token-chunks', onComplete)

    scanner.scan('installing...\r\n__ORCA_SETUP_COMPLETE__:wrong:0\r\n__ORCA_SETUP_COMP')
    scanner.scan('LETE__:token-chunks:1')
    expect(onComplete).not.toHaveBeenCalled()
    scanner.scan('7\r')
    expect(onComplete).not.toHaveBeenCalled()
    scanner.scan('\nPS C:\\repo>')
    scanner.scan('__ORCA_SETUP_COMPLETE__:token-chunks:0\r\n')

    expect(onComplete).toHaveBeenCalledOnce()
    expect(onComplete).toHaveBeenCalledWith(17)
  })

  it.each([3, 30])(
    'scans only each of %i Setup PTYs’ own new bytes, then retires its listeners and deadline once',
    async (count) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const data = new Map<string, (chunk: string) => void>()
      const exits = new Map<string, () => void>()
      const subscriptions = { data: 0, exit: 0, retired: 0 }
      const host = {
        subscribeToData: (ptyId: string, listener: (chunk: string) => void) => {
          subscriptions.data += 1
          data.set(ptyId, listener)
          return () => {
            subscriptions.retired += 1
            data.delete(ptyId)
          }
        },
        subscribeToExit: (ptyId: string, listener: () => void) => {
          subscriptions.exit += 1
          exits.set(ptyId, listener)
          return () => {
            subscriptions.retired += 1
            exits.delete(ptyId)
          }
        }
      }
      const prefix = '__ORCA_SETUP_COMPLETE__:'
      // The scanner reads each chunk plus at most its marker prefix and a 96-character tail.
      const carry = prefix.length + 96
      const scanned: number[] = []
      const lastIndexOf = String.prototype.lastIndexOf
      vi.spyOn(String.prototype, 'lastIndexOf').mockImplementation(function (
        this: string,
        search: string,
        position?: number
      ) {
        if (search.startsWith(prefix)) {
          scanned.push(this.length)
        }
        return lastIndexOf.call(this, search, position)
      })
      const runs = Array.from({ length: count }, (_, index) => {
        const run = createSetupRun(true)
        bindSetupRunToPty(run, `pty-${index}`, `token-${index}`, host)
        return run
      })
      expect(vi.getTimerCount()).toBe(count)
      expect(endpointLoss.live).toBe(count)

      const chunk = 'x'.repeat(4096)
      const chunksPerPty = 4
      for (let round = 0; round < chunksPerPty; round += 1) {
        for (let index = 0; index < count; index += 1) {
          data.get(`pty-${index}`)?.(chunk)
        }
      }
      expect(scanned).toHaveLength(count * chunksPerPty)
      expect(Math.max(...scanned)).toBeLessThanOrEqual(chunk.length + carry)

      // Each run ends its own way: its marker, its PTY's exit, or its endpoint lost.
      for (let index = 0; index < count; index += 1) {
        const ptyId = `pty-${index}`
        if (index % 3 === 0) {
          data.get(ptyId)?.(`\r\n${prefix}token-${index}:${index % 2}\r\n`)
        } else if (index % 3 === 1) {
          exits.get(ptyId)?.()
        } else {
          publishPtyEndpointLoss(ptyId)
        }
      }
      const outcomes: SetupRunOutcome[] = await Promise.all(runs.map((run) => run.outcome))
      expect(outcomes).toEqual(
        runs.map((_, index) =>
          index % 3 === 0
            ? index % 2 === 0
              ? { kind: 'succeeded' }
              : { kind: 'failed', exitCode: 1 }
            : { kind: 'ended', reason: index % 3 === 1 ? 'closed' : 'observation_lost' }
        )
      )
      expect(subscriptions).toEqual({ data: count, exit: count, retired: 2 * count })
      expect(data.size + exits.size).toBe(0)
      expect(endpointLoss.live).toBe(0)
      expect(vi.getTimerCount()).toBe(0)

      // Settled runs hold nothing a late signal could reach or retire twice.
      for (const run of runs) {
        run.settle({ kind: 'ended', reason: 'closed' })
      }
      expect(subscriptions.retired).toBe(2 * count)
      expect(endpointLoss.live).toBe(0)
    }
  )
})
