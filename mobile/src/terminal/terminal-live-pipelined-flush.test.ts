import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cancelTerminalLivePendingFlush,
  createTerminalLivePendingFlushState,
  queueTerminalLiveMirrorSend,
  waitForTerminalLivePendingFlush
} from './terminal-live-pending-flush-state'
import { sendTerminalLiveControlAfterPendingFlush } from './terminal-live-control-send-order'

function deferred() {
  let resolve = (_sent: boolean): void => {}
  const promise = new Promise<boolean>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => vi.useRealTimers())

describe('negotiated live-input pipelining', () => {
  it('dispatches later bytes before receipts, but holds Enter until every receipt', async () => {
    const state = createTerminalLivePendingFlushState()
    const receipts = [deferred(), deferred()]
    const sent: string[] = []
    const sender = (_handle: string, text: string) => {
      sent.push(text)
      return receipts[sent.length - 1].promise
    }
    const a = queueTerminalLiveMirrorSend(state, 'pty', 'a', sender, { pipeline: true })
    const b = queueTerminalLiveMirrorSend(state, 'pty', 'b', sender, { pipeline: true })
    expect(sent).toEqual(['a', 'b'])
    const enter = sendTerminalLiveControlAfterPendingFlush(
      () => waitForTerminalLivePendingFlush(state),
      async () => {
        sent.push('\r')
        return true
      }
    )
    receipts[1].resolve(true)
    await b
    expect(sent).toEqual(['a', 'b'])
    receipts[0].resolve(true)
    await a
    await expect(enter).resolves.toBe(true)
    expect(sent).toEqual(['a', 'b', '\r'])
    expect(state.retainedBytes).toBe(0)
    expect(state.requestCount).toBe(0)
  })

  it('latches an out-of-order failure after earlier receipts and refuses Enter', async () => {
    const state = createTerminalLivePendingFlushState()
    const receipts = [deferred(), deferred()]
    let index = 0
    const sender = () => receipts[index++].promise
    const a = queueTerminalLiveMirrorSend(state, 'pty', 'a', sender, { pipeline: true })
    const b = queueTerminalLiveMirrorSend(state, 'pty', 'b', sender, { pipeline: true })
    receipts[1].resolve(false)
    await expect(b).resolves.toBe(false)
    receipts[0].resolve(true)
    await a
    expect(state.current).toBeNull()
    const control = vi.fn(async () => true)
    await expect(
      sendTerminalLiveControlAfterPendingFlush(
        () => waitForTerminalLivePendingFlush(state),
        control
      )
    ).resolves.toBe(false)
    expect(control).not.toHaveBeenCalled()
    await expect(
      queueTerminalLiveMirrorSend(state, 'pty', 'suffix', sender, { pipeline: true })
    ).resolves.toBe(false)
    expect(index).toBe(2)
  })

  it('does not pipeline past a legacy RPC still awaiting its reply', async () => {
    const state = createTerminalLivePendingFlushState()
    const first = deferred()
    const sent: string[] = []
    const sender = async (_handle: string, text: string) => {
      sent.push(text)
      return text === 'old' ? first.promise : true
    }
    const legacy = queueTerminalLiveMirrorSend(state, 'pty', 'old', sender)
    const modern = queueTerminalLiveMirrorSend(state, 'pty', 'new', sender, { pipeline: true })
    expect(sent).toEqual(['old'])
    first.resolve(true)
    await Promise.all([legacy, modern])
    expect(sent).toEqual(['old', 'new'])
  })

  it('bounds outstanding request bookkeeping and resets only on explicit cancellation', async () => {
    const state = createTerminalLivePendingFlushState()
    const receipt = deferred()
    const sender = vi.fn(() => receipt.promise)
    const requests = Array.from({ length: 64 }, () =>
      queueTerminalLiveMirrorSend(state, 'pty', 'x', sender, { pipeline: true })
    )
    await expect(
      queueTerminalLiveMirrorSend(state, 'pty', 'overflow', sender, { pipeline: true })
    ).resolves.toBe(false)
    expect(sender).toHaveBeenCalledTimes(64)
    expect(state.requestCount).toBe(64)
    cancelTerminalLivePendingFlush(state)
    await expect(Promise.all(requests)).resolves.toEqual(Array(64).fill(false))
    expect(state.retainedBytes).toBe(0)
    expect(state.requestCount).toBe(0)
    await expect(
      queueTerminalLiveMirrorSend(state, 'replacement', 'fresh', async () => true, {
        pipeline: true
      })
    ).resolves.toBe(true)
    receipt.resolve(false)
    await Promise.resolve()
    await expect(waitForTerminalLivePendingFlush(state)).resolves.toBe(true)
  })

  it('bounds UTF-8 frame and total bytes, including acknowledged-later batches', async () => {
    const state = createTerminalLivePendingFlushState()
    const receipt = deferred()
    const sender = vi.fn(() => receipt.promise)
    const payload = 'é'.repeat(128 * 1024)
    const requests = Array.from({ length: 4 }, () =>
      queueTerminalLiveMirrorSend(state, 'pty', payload, sender, { pipeline: true })
    )
    expect(state.retainedBytes).toBe(1024 * 1024)
    await expect(
      queueTerminalLiveMirrorSend(state, 'pty', 'x', sender, { pipeline: true })
    ).resolves.toBe(false)
    expect(sender).toHaveBeenCalledTimes(4)
    cancelTerminalLivePendingFlush(state)
    await Promise.all(requests)
    await expect(
      queueTerminalLiveMirrorSend(state, 'pty', payload + 'x', sender, { pipeline: true })
    ).resolves.toBe(false)
    expect(sender).toHaveBeenCalledTimes(4)
    receipt.resolve(false)
  })

  it.each([300, 400, 500])(
    'keeps 50ms typing cadence under %ims receipts without weakening completion',
    async (rtt) => {
      vi.useFakeTimers()
      const state = createTerminalLivePendingFlushState()
      const arrivals: { text: string; at: number }[] = []
      const started = Date.now()
      const sender = (_handle: string, text: string) => {
        arrivals.push({ text, at: Date.now() - started })
        return new Promise<boolean>((resolve) => setTimeout(() => resolve(true), rtt))
      }
      const requests: Promise<boolean>[] = []
      for (const text of ['a', 'b', 'c', 'd']) {
        requests.push(queueTerminalLiveMirrorSend(state, 'pty', text, sender, { pipeline: true }))
        await vi.advanceTimersByTimeAsync(50)
      }
      expect(arrivals).toEqual([
        { text: 'a', at: 0 },
        { text: 'b', at: 50 },
        { text: 'c', at: 100 },
        { text: 'd', at: 150 }
      ])
      let completed = false
      void waitForTerminalLivePendingFlush(state).then(() => {
        completed = true
      })
      await vi.advanceTimersByTimeAsync(rtt - 51)
      expect(completed).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(Promise.all(requests)).resolves.toEqual([true, true, true, true])
      expect(completed).toBe(true)
    }
  )
})
