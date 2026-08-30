import { describe, expect, it, vi } from 'vitest'
import type { WindowCloseRequestPayload } from '../shared/window-close-request'
import { subscribeToWindowCloseRequest } from './window-close-request-subscription'

type Listener = (event: unknown, data: unknown) => void

function installIpc(): {
  ipcRenderer: Parameters<typeof subscribeToWindowCloseRequest>[0]
  emit: (data: unknown) => void
  sent: unknown[][]
  removed: Listener[]
} {
  const listeners: Listener[] = []
  const sent: unknown[][] = []
  const removed: Listener[] = []
  const ipcRenderer = {
    on: vi.fn((_channel: string, listener: Listener) => {
      listeners.push(listener)
      return ipcRenderer
    }),
    removeListener: vi.fn((_channel: string, listener: Listener) => {
      removed.push(listener)
      return ipcRenderer
    }),
    send: vi.fn((_channel: string, ...args: unknown[]) => {
      sent.push(args)
    })
  } as unknown as Parameters<typeof subscribeToWindowCloseRequest>[0]
  return {
    ipcRenderer,
    emit: (data: unknown) => {
      for (const listener of listeners) {
        listener({}, data)
      }
    },
    sent,
    removed
  }
}

function deliver(data: unknown): {
  payload: WindowCloseRequestPayload | null
  sent: unknown[][]
} {
  const { ipcRenderer, emit, sent } = installIpc()
  let payload: WindowCloseRequestPayload | null = null
  subscribeToWindowCloseRequest(ipcRenderer, (received) => {
    payload = received
  })
  emit(data)
  return { payload, sent }
}

/**
 * The whole quit-survival property rests on this hop: main's answer crosses IPC
 * untyped, and the renderer spends `localPtysSurviveQuit: true` by closing over
 * running terminals with no warning. Nothing else in the tree reads the payload,
 * so if the normalization is skipped here it is skipped everywhere — which is
 * exactly what happened while this listener was inline in index.ts and no test
 * could reach it.
 */
describe('window close request subscription', () => {
  it('delivers an explicit survival yes unchanged', () => {
    const { payload } = deliver({ isQuitting: true, localPtysSurviveQuit: true, requestId: 4 })

    expect(payload).toEqual({ isQuitting: true, localPtysSurviveQuit: true, requestId: 4 })
  })

  it.each([
    ['a truthy string', 'yes'],
    ['a truthy number', 1],
    ['an object', {}],
    ['null', null]
  ])('refuses to spend %s as a survival yes', (_label, value) => {
    const { payload } = deliver({ isQuitting: true, localPtysSurviveQuit: value })

    expect(payload?.localPtysSurviveQuit).toBe(false)
  })

  /** Same rule, the decision's other input. A truthy non-boolean quit flag read as a
   *  yes drops SSH-backed panes from the evidence on its own, without any help from the
   *  survival answer, so this hop must refuse it just as strictly. */
  it.each([
    ['a truthy string', 'yes'],
    ['a truthy number', 1],
    ['an object', {}],
    ['null', null]
  ])('refuses to read %s as a quit', (_label, value) => {
    const { payload } = deliver({ isQuitting: value, localPtysSurviveQuit: false })

    expect(payload?.isQuitting).toBe(false)
  })

  it('reads a payload with no survival field as "does not survive"', () => {
    const { payload } = deliver({ isQuitting: true })

    expect(payload?.localPtysSurviveQuit).toBe(false)
  })

  it('still answers when the payload is not an object at all', () => {
    const { payload, sent } = deliver(undefined)

    expect(payload).toEqual({
      isQuitting: false,
      localPtysSurviveQuit: false,
      requestId: undefined
    })
    expect(sent).toEqual([[undefined]])
  })

  // Why the ack and not just the payload: main clears its force-destroy timer on an
  // exact requestId match, so echoing a non-numeric one back would never match and a
  // frozen-renderer quit would sit on the timer instead of being acknowledged.
  it('acknowledges before the renderer runs, echoing only a numeric requestId', () => {
    const order: string[] = []
    const { ipcRenderer, emit, sent } = installIpc()
    vi.mocked(ipcRenderer.send).mockImplementation((_channel: string, ...args: unknown[]) => {
      order.push('ack')
      sent.push(args)
    })
    subscribeToWindowCloseRequest(ipcRenderer, () => order.push('callback'))

    emit({ isQuitting: true, requestId: 9 })
    emit({ isQuitting: true, requestId: '9' })

    expect(order).toEqual(['ack', 'callback', 'ack', 'callback'])
    expect(sent).toEqual([[9], [undefined]])
  })

  it('unsubscribes the listener it registered', () => {
    const { ipcRenderer, removed } = installIpc()

    const dispose = subscribeToWindowCloseRequest(ipcRenderer, () => {})
    dispose()

    expect(removed).toHaveLength(1)
    expect(removed[0]).toBe(vi.mocked(ipcRenderer.on).mock.calls[0][1])
  })
})
