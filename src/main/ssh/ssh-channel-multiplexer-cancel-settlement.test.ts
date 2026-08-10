import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayDispatcher, type RequestContext } from '../../relay/dispatcher'
import { SshChannelMultiplexer, type MultiplexerTransport } from './ssh-channel-multiplexer'

type LinkedTransport = MultiplexerTransport & {
  receive: ((data: Buffer) => void) | undefined
  close: (() => void) | undefined
}

function createLinkedPair(): {
  dispatcher: RelayDispatcher
  mux: SshChannelMultiplexer
} {
  let dispatcher!: RelayDispatcher
  const transport: LinkedTransport = {
    receive: undefined,
    close: undefined,
    write: (data) => dispatcher.feed(data),
    onData: (handler) => {
      transport.receive = handler
    },
    onClose: (handler) => {
      transport.close = handler
    }
  }
  const mux = new SshChannelMultiplexer(transport)
  dispatcher = new RelayDispatcher((data) => transport.receive?.(Buffer.from(data)))
  return { dispatcher, mux }
}

function waitForAbort(context: RequestContext): Promise<void> {
  if (context.signal?.aborted) {
    return Promise.resolve()
  }
  return new Promise((resolve) => context.signal?.addEventListener('abort', () => resolve()))
}

const disposals: (() => void)[] = []

afterEach(() => {
  for (const dispose of disposals.splice(0)) {
    dispose()
  }
})

describe('SSH mux and relay dispatcher cancellation settlement', () => {
  it('publishes cleanup settlement after opted-in rpc.cancel', async () => {
    const { dispatcher, mux } = createLinkedPair()
    disposals.push(
      () => mux.dispose(),
      () => dispatcher.dispose()
    )
    let finishCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve
    })
    dispatcher.onRequest('git.addWorktreeWithCleanupSettlement', async (_params, context) => {
      await waitForAbort(context)
      await cleanup
      throw new Error('cancelled after cleanup settled')
    })
    const controller = new AbortController()
    const request = mux.request(
      'git.addWorktreeWithCleanupSettlement',
      {},
      { signal: controller.signal, waitForRemoteCancellation: true }
    )
    let settled = false
    void request.catch(() => {
      settled = true
    })

    controller.abort()
    await vi.waitFor(() => expect(settled).toBe(false))
    finishCleanup()

    await expect(request).rejects.toThrow('cancelled after cleanup settled')
  })

  it('keeps ordinary cancelled relay responses suppressed', async () => {
    const { dispatcher, mux } = createLinkedPair()
    disposals.push(
      () => mux.dispose(),
      () => dispatcher.dispose()
    )
    dispatcher.onRequest('ordinary.request', async (_params, context) => {
      await waitForAbort(context)
      throw new Error('late ordinary response')
    })
    const controller = new AbortController()
    const request = mux.request('ordinary.request', {}, { signal: controller.signal })

    controller.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('settles the previous cleanup RPC when cancel lacks the new optional field', async () => {
    const { dispatcher, mux } = createLinkedPair()
    disposals.push(
      () => mux.dispose(),
      () => dispatcher.dispose()
    )
    dispatcher.onRequest('git.addWorktreeWithCleanup', async (_params, context) => {
      context.allowCancellationSettlement?.()
      await waitForAbort(context)
      throw new Error('old client cleanup settled')
    })
    const request = mux.request('git.addWorktreeWithCleanup')

    mux.notify('rpc.cancel', { id: 1 })

    await expect(request).rejects.toThrow('old client cleanup settled')
  })
})
