import { describe, expect, it } from 'vitest'
import { PtyInputTransactions } from './pty-input-transactions'

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const binding = (key = 'pty') => ({ key, isCurrent: () => true })

describe('PTY input ownership', () => {
  it('runs free writes synchronously and preserves queued keystroke order', async () => {
    const queue = new PtyInputTransactions()
    const bytes: string[] = []
    expect(
      queue.run(binding(), () => {
        bytes.push('a')
        return true
      })
    ).toBe(true)
    expect(bytes).toEqual(['a'])
    expect(queue.size).toBe(0)
    const hold = deferred()
    const active = queue.run(binding(), () => hold.promise)
    const b = queue.run(binding(), () => bytes.push('b'))
    const c = queue.run(binding(), () => bytes.push('c'))
    expect(bytes).toEqual(['a'])
    hold.resolve()
    await Promise.all([active, b, c])
    expect(bytes).toEqual(['a', 'b', 'c'])
    expect(queue.size).toBe(0)
  })

  it('lets independent PTYs proceed while a predecessor is pending', async () => {
    const queue = new PtyInputTransactions()
    const hold = deferred()
    const active = queue.run(binding('A'), () => hold.promise)
    expect(queue.run(binding('B'), () => 'B')).toBe('B')
    expect(queue.size).toBe(1)
    hold.resolve()
    await active
    expect(queue.size).toBe(0)
  })

  it('releases after rejected and thrown operations without deleting a later tail', async () => {
    const queue = new PtyInputTransactions()
    const hold = deferred()
    const failed = queue.run(binding(), async () => {
      await hold.promise
      throw new Error('failed')
    })
    const failure = expect(failed).rejects.toThrow('failed')
    const nextHold = deferred()
    const next = queue.run(binding(), () => nextHold.promise)
    hold.resolve()
    await failure
    expect(queue.size).toBe(1)
    nextHold.resolve()
    await next
    expect(queue.size).toBe(0)
    expect(() =>
      queue.run(binding(), () => {
        throw new Error('thrown')
      })
    ).toThrow('thrown')
    expect(queue.size).toBe(0)
  })

  it('removes an aborted queued entry immediately with no effect', async () => {
    const queue = new PtyInputTransactions()
    const hold = deferred()
    const active = queue.run(binding(), () => hold.promise)
    const abort = new AbortController()
    let wrote = false
    const cancelled = queue.run(
      binding(),
      () => {
        wrote = true
      },
      { signal: abort.signal }
    )
    const cancellation = expect(cancelled).rejects.toThrow('request_aborted')
    const next = queue.run(binding(), () => 'next')
    abort.abort()
    await cancellation
    expect(wrote).toBe(false)
    hold.resolve()
    await active
    expect(await next).toBe('next')
    expect(queue.size).toBe(0)
  })

  it('prioritizes interrupts without reordering queued work', async () => {
    const queue = new PtyInputTransactions()
    const hold = deferred()
    const bytes: string[] = []
    const active = queue.run(binding(), async (tx) => {
      tx.handoff()
      bytes.push('text')
      await hold.promise
      tx.handoff()
      bytes.push('suffix')
    })
    const partial = expect(active).rejects.toThrow('partial_write')
    const next = queue.run(binding(), () => bytes.push('B'), { rawInput: true })
    const interrupt = queue.run(binding(), () => bytes.push('\x03'), { interrupt: true })
    const last = queue.run(binding(), () => bytes.push('C'))
    hold.resolve()
    await Promise.all([partial, interrupt, next, last])
    expect(bytes).toEqual(['text', 'B', '\x03', 'C'])
    expect(queue.size).toBe(0)
  })

  it('starts a replacement immediately and fences retired queued and active work', async () => {
    const queue = new PtyInputTransactions()
    const hold = deferred()
    let incarnation = 'old'
    const old = { key: 'pty:old', isCurrent: () => incarnation === 'old' }
    const active = queue.run(old, async (tx) => {
      await hold.promise
      tx.handoff()
    })
    const retired = expect(active).rejects.toThrow('terminal_not_writable')
    const pending = queue.run(old, () => 'obsolete')
    const refused = expect(pending).rejects.toThrow('terminal_not_writable')
    incarnation = 'new'
    expect(queue.run(binding('pty:new'), () => 'replacement')).toBe('replacement')
    hold.resolve()
    await Promise.all([retired, refused])
    expect(queue.size).toBe(0)
  })
})
