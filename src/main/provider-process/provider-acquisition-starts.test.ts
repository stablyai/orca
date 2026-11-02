import { describe, expect, it, vi } from 'vitest'
import { ProviderAcquisitionStarts } from './provider-acquisition-starts'
import type { ProviderProcessCloseResult } from './provider-process-close'

function connection(result: boolean | ProviderProcessCloseResult = false) {
  const exits: (() => void)[] = []
  return {
    close: vi.fn(async (): Promise<boolean | ProviderProcessCloseResult> => result),
    onExit: (listener: () => void) => {
      exits.push(listener)
    },
    exit: () => {
      for (const listener of exits.splice(0)) {
        listener()
      }
    }
  }
}

describe('provider acquisition ownership', () => {
  it('stops a connection created after the host already aborted its start', async () => {
    const starts = new ProviderAcquisitionStarts<ReturnType<typeof connection>>()
    const controller = new AbortController()
    const attempt = starts.begin(controller.signal)
    controller.abort()
    const child = connection(true)
    starts.track(attempt, child)
    expect(child.close).toHaveBeenCalledOnce()
    starts.end(attempt)
  })

  it('detaches startup cancellation when ownership transfers to the session', () => {
    const starts = new ProviderAcquisitionStarts<ReturnType<typeof connection>>()
    const controller = new AbortController()
    const attempt = starts.begin(controller.signal)
    const child = connection(true)
    starts.track(attempt, child)
    starts.end(attempt)
    controller.abort()
    expect(child.close).not.toHaveBeenCalled()
  })

  it('retains a failed start after refused cleanup and retries that same child', async () => {
    const starts = new ProviderAcquisitionStarts<ReturnType<typeof connection>>()
    const child = connection()
    child.close
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('unreachable'))
      .mockResolvedValueOnce(true)
    starts.retainFailed('session', child)
    expect(await starts.stopFailed('session')).toBe(false)
    expect(await starts.stopFailed('session')).toBe(false)
    expect(starts.failedSessionIds()).toEqual(['session'])
    expect(await starts.stopFailed('session')).toBe(true)
    expect(starts.failedSessionIds()).toEqual([])
    expect(child.close).toHaveBeenCalledTimes(3)
  })

  it('releases ownership on root proof while descendant cleanup remains reported by the connection', async () => {
    const starts = new ProviderAcquisitionStarts<ReturnType<typeof connection>>()
    const child = connection({ root: 'unverifiable', tree: 'unverifiable' })
    child.close
      .mockResolvedValueOnce({ root: 'unverifiable', tree: 'exited' })
      .mockResolvedValueOnce({ root: 'exited', tree: 'unverifiable' })
    starts.retainFailed('session', child)
    expect(await starts.stopFailed('session')).toBe(false)
    expect(await starts.stopFailed('session')).toBe(true)
    expect(starts.failedSessionIds()).toEqual([])
  })

  it('does not let a previous child exit erase a newer failed owner', () => {
    const starts = new ProviderAcquisitionStarts<ReturnType<typeof connection>>()
    const old = connection(),
      current = connection()
    starts.retainFailed('session', old)
    starts.retainFailed('session', current)
    old.exit()
    expect(starts.failedSessionIds()).toEqual(['session'])
    current.exit()
    expect(starts.failedSessionIds()).toEqual([])
  })
})
