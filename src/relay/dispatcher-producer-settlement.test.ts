import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayDispatcher, type SinkWriteSettlement } from './dispatcher'

describe('producer notification settlement', () => {
  const dispatchers: RelayDispatcher[] = []
  const setup = (highWaterMark?: number) => {
    const writes: ((result: SinkWriteSettlement) => void)[] = []
    const dispatcher = new RelayDispatcher(
      (_bytes, settled) => {
        writes.push(settled)
        return true
      },
      { supportsWriteCallback: true, writableHighWaterMark: () => highWaterMark ?? Infinity }
    )
    dispatchers.push(dispatcher)
    return { dispatcher, writes }
  }
  afterEach(() => {
    for (const dispatcher of dispatchers.splice(0)) {
      dispatcher.dispose()
    }
  })

  it('waits for sink settlement rather than enqueue acceptance and settles once', () => {
    const { dispatcher, writes } = setup()
    const onSettled = vi.fn()
    expect(dispatcher.publishProducerNotification(1, 'tunnel.frame', {}, { onSettled })).toBe(true)
    expect(onSettled).not.toHaveBeenCalled()
    writes[0]({ ok: true })
    writes[0]({ ok: false, error: new Error('late duplicate') })
    expect(onSettled).toHaveBeenCalledExactlyOnceWith({ ok: true })
  })

  it('retains sink failure and cannot turn disposal into successful publication', () => {
    const { dispatcher, writes } = setup()
    const onSettled = vi.fn()
    dispatcher.publishProducerNotification(1, 'tunnel.frame', {}, { onSettled })
    const error = new Error('write failed')
    writes[0]({ ok: false, error })
    dispatcher.dispose()
    expect(onSettled).toHaveBeenCalledExactlyOnceWith({ ok: false, error })
  })

  it('fails outstanding publication on disposal even if a late write succeeds', () => {
    const { dispatcher, writes } = setup()
    const onSettled = vi.fn()
    dispatcher.publishProducerNotification(1, 'tunnel.frame', {}, { onSettled })
    dispatcher.dispose()
    writes[0]({ ok: true })
    expect(onSettled).toHaveBeenCalledExactlyOnceWith({ ok: false, error: expect.any(Error) })
  })

  it('reports bounded producer refusal without closing the client or taking the control lane', () => {
    const { dispatcher, writes } = setup(16384)
    const onSettled = vi.fn()
    const detached = vi.fn()
    dispatcher.onClientDetached(detached)
    expect(
      dispatcher.publishProducerNotification(
        1,
        'tunnel.frame',
        { data: 'x'.repeat(20000) },
        {
          onSettled,
          logDrop: false
        }
      )
    ).toBe(false)
    expect(onSettled).toHaveBeenCalledExactlyOnceWith({ ok: false, error: expect.any(Error) })
    expect(writes).toHaveLength(0)
    expect(detached).not.toHaveBeenCalled()
    expect(dispatcher.publishProducerNotification(1, 'tunnel.frame', {})).toBe(true)
  })

  it.each(['missing', 'disposed', 'pty-admission'] as const)('settles %s refusal', (reason) => {
    const { dispatcher, writes } = setup()
    const onSettled = vi.fn()
    if (reason === 'disposed') {
      dispatcher.dispose()
    }
    if (reason === 'pty-admission') {
      dispatcher.registerPtyDataPublicationAdmission(() => false)
    }
    expect(
      dispatcher.publishProducerNotification(
        reason === 'missing' ? 999 : 1,
        reason === 'pty-admission' ? 'pty.data' : 'tunnel.frame',
        {},
        { onSettled }
      )
    ).toBe(false)
    expect(onSettled).toHaveBeenCalledExactlyOnceWith({ ok: false, error: expect.any(Error) })
    expect(writes).toHaveLength(0)
  })

  it('settles serialization failure while preserving the existing throw contract', () => {
    const { dispatcher } = setup()
    const onSettled = vi.fn()
    const params: Record<string, unknown> = {}
    params.circular = params
    expect(() =>
      dispatcher.publishProducerNotification(1, 'tunnel.frame', params, { onSettled })
    ).toThrow()
    expect(onSettled).toHaveBeenCalledExactlyOnceWith({ ok: false, error: expect.any(Error) })
  })
})
