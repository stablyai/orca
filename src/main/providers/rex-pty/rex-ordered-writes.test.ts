import { describe, expect, it, vi } from 'vitest'
import { RexOrderedWrites } from './rex-ordered-writes'
import {
  WRITE_ACCEPTED,
  writeUnverifiable,
  type WriteSettlement
} from '../../../shared/terminal/pty/lifecycle/pty-write-settlement'

describe('Rex ordered input', () => {
  it('waits for the preceding RPC settlement before dispatching the next bytes', async () => {
    const writes = new RexOrderedWrites()
    const owner = { id: 'shell' }
    let release: () => void = () => {}
    const dispatch = vi.fn(async (data: string): Promise<WriteSettlement> => {
      if (data === 'p') {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return WRITE_ACCEPTED
    })
    const results = ['p', 'r', 'i', 'n', 't', 'f'].map((data) =>
      writes.submit(
        owner,
        1,
        () => true,
        () => dispatch(data)
      )
    )
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    release()
    expect(await Promise.all(results)).toEqual(Array(6).fill(WRITE_ACCEPTED))
    expect(dispatch.mock.calls.flat()).toEqual(['p', 'r', 'i', 'n', 't', 'f'])
  })
  it('never dispatches the suffix after ambiguous settlement', async () => {
    const writes = new RexOrderedWrites()
    const owner = { id: 'shell' }
    const ambiguous = writeUnverifiable('transport_settlement_lost', true)
    const send = vi.fn(async () => ambiguous)
    const first = writes.submit(owner, 1, () => true, send)
    const second = writes.submit(owner, 1, () => true, send)
    expect(await first).toEqual(ambiguous)
    expect((await second).outcome).toBe('refused')
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('fences queued input after suspend or stream replacement', async () => {
    const writes = new RexOrderedWrites()
    const owner = { id: 'shell' }
    let current = true
    const send = vi.fn(async () => {
      current = false
      return WRITE_ACCEPTED
    })
    const first = writes.submit(owner, 1, () => current, send)
    const second = writes.submit(owner, 1, () => current, send)
    expect(await first).toEqual(WRITE_ACCEPTED)
    expect((await second).outcome).toBe('refused')
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('bounds queued bytes and refuses the queued suffix on overflow', async () => {
    const writes = new RexOrderedWrites()
    const owner = { id: 'shell' }
    const send = vi.fn(async () => WRITE_ACCEPTED)
    const first = writes.submit(owner, 1024 * 1024, () => true, send)
    const second = writes.submit(owner, 1024 * 1024, () => true, send)
    const overflow = writes.submit(owner, 1, () => true, send)
    expect((await overflow).outcome).toBe('refused')
    expect((await first).outcome).toBe('refused')
    expect((await second).outcome).toBe('refused')
    expect(send).not.toHaveBeenCalled()
  })
})
