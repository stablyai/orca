import { describe, expect, it, vi } from 'vitest'
import type { PtyDataEvent } from './pty-provider-events'
import { RuntimePtyOwnershipTransferProviderObserver } from './runtime-pty-ownership-transfer-provider-observer'

type ExitEvent = {
  id: string
  code: number
  incarnationId?: string
}

function createProviderEvents() {
  let data: ((event: PtyDataEvent) => void) | null = null
  let exit: ((event: ExitEvent) => void) | null = null
  return {
    provider: {
      onData: (listener: (event: PtyDataEvent) => void) => {
        data = listener
        return () => {
          data = null
        }
      },
      onExit: (listener: (event: ExitEvent) => void) => {
        exit = listener
        return () => {
          exit = null
        }
      }
    },
    emitData: (event: PtyDataEvent) => data?.(event),
    emitExit: (event: ExitEvent) => exit?.(event),
    isSubscribed: () => data !== null && exit !== null
  }
}

describe('RuntimePtyOwnershipTransferProviderObserver', () => {
  it('forwards only incarnation-bound output with a stable sequenced emission key', () => {
    const events = createProviderEvents()
    const observeOutput = vi.fn()
    const observer = new RuntimePtyOwnershipTransferProviderObserver(events.provider as never, {
      observeOutput,
      observeExit: vi.fn()
    })

    events.emitData({ id: 'pty-1', data: 'unknown' })
    events.emitData({
      id: 'pty-1',
      incarnationId: 'incarnation-1',
      data: 'exact',
      sequenceChars: 5,
      seq: 9
    })
    expect(observeOutput).toHaveBeenCalledOnce()
    expect(observeOutput).toHaveBeenCalledWith({
      terminalId: 'pty-1',
      incarnationId: 'incarnation-1',
      data: 'exact',
      emissionKey: 'incarnation-1:9:5'
    })

    observer.dispose()
    expect(events.isSubscribed()).toBe(false)
  })

  it('forwards only host-positive incarnation-bound exit', () => {
    const events = createProviderEvents()
    const observeExit = vi.fn()
    const observer = new RuntimePtyOwnershipTransferProviderObserver(events.provider as never, {
      observeOutput: vi.fn(),
      observeExit
    })

    events.emitExit({ id: 'pty-1', code: -1 })
    expect(observeExit).not.toHaveBeenCalled()
    events.emitExit({ id: 'pty-1', code: 0, incarnationId: 'incarnation-1' })
    expect(observeExit).toHaveBeenCalledWith({
      terminalId: 'pty-1',
      incarnationId: 'incarnation-1',
      code: 0
    })
    observer.dispose()
  })

  it('disposes idempotently and stops all journal observation', () => {
    const events = createProviderEvents()
    const observeOutput = vi.fn()
    const observer = new RuntimePtyOwnershipTransferProviderObserver(events.provider as never, {
      observeOutput,
      observeExit: vi.fn()
    })

    observer.dispose()
    observer.dispose()
    events.emitData({
      id: 'pty-1',
      incarnationId: 'incarnation-1',
      data: 'after-dispose'
    })
    expect(observeOutput).not.toHaveBeenCalled()
  })
})
