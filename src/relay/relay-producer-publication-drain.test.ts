import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayDispatcher, type SinkWriteSettlement } from './dispatcher'
import { RelayProducerPublicationDrain } from './relay-producer-publication-drain'

describe('relay producer publication drain', () => {
  const dispatchers: RelayDispatcher[] = []
  const setup = (synchronous = false) => {
    const writes: ((result: SinkWriteSettlement) => void)[] = []
    const dispatcher = new RelayDispatcher(
      (_bytes, settle) => {
        writes.push(settle)
        if (synchronous) {
          settle({ ok: true })
        }
        return true
      },
      { supportsWriteCallback: true }
    )
    dispatchers.push(dispatcher)
    const assertAuthority = vi.fn()
    const publication = new RelayProducerPublicationDrain(dispatcher, 1, 0, assertAuthority)
    return { dispatcher, publication, writes, assertAuthority }
  }
  afterEach(() => {
    for (const dispatcher of dispatchers.splice(0)) {
      dispatcher.dispose()
    }
  })

  it('waits for all callbacks, including frames published while waiting', async () => {
    const { publication, writes } = setup()
    publication.publish('tunnel.frame', {})
    const done = vi.fn()
    const drain = publication.drain(new AbortController().signal).then(done)
    publication.publish('tunnel.frame', {})
    writes[0]({ ok: true })
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    expect(() => publication.assertDrained()).toThrow('not_drained')
    writes[1]({ ok: true })
    await drain
    expect(done).toHaveBeenCalledOnce()
  })

  it('accounts before synchronous settlement', async () => {
    const { publication } = setup(true)
    expect(publication.publish('tunnel.frame', {})).toBe(true)
    await publication.drain(new AbortController().signal)
    expect(() => publication.assertDrained()).not.toThrow()
  })

  it('aborts only observation and retains an ensuing failure for retry', async () => {
    const { publication, writes } = setup()
    publication.publish('tunnel.frame', {})
    const controller = new AbortController()
    const drain = publication.drain(controller.signal)
    controller.abort(new Error('observer cancelled'))
    await expect(drain).rejects.toThrow('observer cancelled')
    expect(() => publication.assertDrained()).toThrow('not_drained')
    writes[0]({ ok: false, error: new Error('lost write') })
    await expect(publication.drain(new AbortController().signal)).rejects.toThrow('lost write')
    expect(publication.publish('tunnel.frame', {})).toBe(false)
    expect(writes).toHaveLength(1)
  })

  it('can retry an aborted observation after successful write settlement', async () => {
    const { publication, writes } = setup()
    publication.publish('tunnel.frame', {})
    const controller = new AbortController()
    const drain = publication.drain(controller.signal)
    controller.abort()
    await expect(drain).rejects.toThrow()
    writes[0]({ ok: true })
    await publication.drain(new AbortController().signal)
  })

  it('wakes every observer on failure despite outstanding writes', async () => {
    const { publication } = setup()
    publication.publish('tunnel.frame', {})
    const first = publication.drain(new AbortController().signal)
    const second = publication.drain(new AbortController().signal)
    publication.fail(new Error('transport lost'))
    await expect(first).rejects.toThrow('transport lost')
    await expect(second).rejects.toThrow('transport lost')
  })

  it('rejects replacement even when all old writes already completed', () => {
    const { publication, dispatcher } = setup(true)
    publication.publish('tunnel.frame', {})
    const replacement = vi.fn(() => true)
    dispatcher.setWrite(replacement, { supportsWriteCallback: true })
    expect(() => publication.assertDrained()).toThrow('transport_unverifiable')
    expect(publication.publish('tunnel.frame', {})).toBe(false)
    expect(replacement).not.toHaveBeenCalled()
  })

  it('fails pending writes on replacement and ignores their late success', async () => {
    const { publication, dispatcher, writes } = setup()
    publication.publish('tunnel.frame', {})
    const drain = publication.drain(new AbortController().signal)
    dispatcher.setWrite(() => true, { supportsWriteCallback: true })
    writes[0]({ ok: true })
    await expect(drain).rejects.toThrow('sink replaced')
  })

  it('refuses callback-less sinks, even if they synchronously accept writes', () => {
    const dispatcher = new RelayDispatcher(() => true)
    dispatchers.push(dispatcher)
    expect(() => new RelayProducerPublicationDrain(dispatcher, 1, 0, () => {})).toThrow(
      'write_callback_required'
    )
  })

  it('retains pre-drain serialization failure', async () => {
    const { publication, writes } = setup()
    const params: Record<string, unknown> = {}
    params.circular = params
    expect(publication.publish('tunnel.frame', params)).toBe(false)
    await expect(publication.drain(new AbortController().signal)).rejects.toThrow()
    expect(writes).toHaveLength(0)
  })

  it('revalidates generation after serialization before enqueue', () => {
    const { publication, dispatcher, writes } = setup()
    const replacement = vi.fn(() => true)
    expect(
      publication.publish('tunnel.frame', {
        toJSON: () => {
          dispatcher.setWrite(replacement, { supportsWriteCallback: true })
          return {}
        }
      })
    ).toBe(false)
    expect(writes).toHaveLength(0)
    expect(replacement).not.toHaveBeenCalled()
    expect(() => publication.assertDrained()).toThrow('transport_unverifiable')
  })

  it('revalidates owner at emission and retains its failure', () => {
    const { publication, assertAuthority, writes } = setup()
    expect(
      publication.publish('tunnel.frame', {
        toJSON: () => {
          assertAuthority.mockImplementation(() => {
            throw new Error('owner changed')
          })
          return {}
        }
      })
    ).toBe(false)
    expect(writes).toHaveLength(0)
    expect(() => publication.assertDrained()).toThrow('owner changed')
  })

  it('refuses queued frames when ownership changes during backpressure', async () => {
    let resume: (() => void) | undefined
    let ownerCurrent = true
    const writes: ((result: SinkWriteSettlement) => void)[] = []
    const dispatcher = new RelayDispatcher(
      (_bytes, settle) => {
        writes.push(settle)
        return false
      },
      {
        supportsWriteCallback: true,
        waitWriteDrain: (callback) => {
          resume = callback
        }
      }
    )
    dispatchers.push(dispatcher)
    const publication = new RelayProducerPublicationDrain(dispatcher, 1, 0, () => {
      if (!ownerCurrent) {
        throw new Error('owner replaced while queued')
      }
    })
    expect(publication.publish('tunnel.frame', { sequence: 1 })).toBe(true)
    expect(publication.publish('tunnel.frame', { sequence: 2 })).toBe(true)
    expect(writes).toHaveLength(1)
    const drain = publication.drain(new AbortController().signal)
    ownerCurrent = false
    writes[0]({ ok: true })
    expect(resume).toBeTypeOf('function')
    resume!()
    await expect(drain).rejects.toThrow('owner replaced while queued')
    expect(writes).toHaveLength(1)
  })
})
