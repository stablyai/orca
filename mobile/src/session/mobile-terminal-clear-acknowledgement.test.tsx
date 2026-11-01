import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'
import { useMobileSessionTerminalInput } from './use-mobile-session-terminal-input'

function mountClear(sendRequest: () => Promise<RpcResponse>, opts: { subscribed?: boolean } = {}) {
  let generation = 1
  const client = { sendRequest, getGeneration: () => generation }
  const clear = vi.fn()
  const terminal = { clear }
  let currentTerminal = terminal
  const clientRef = { current: client }
  const showToast = vi.fn()
  const unsubscribeTerminal = vi.fn()
  const subscribeToTerminal = vi.fn()
  const terminalUnsubsRef = {
    current: new Map<string, () => void>(opts.subscribed === false ? [] : [['term', () => {}]])
  }
  let actions: ReturnType<typeof useMobileSessionTerminalInput> | undefined
  function Harness() {
    actions = useMobileSessionTerminalInput(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies every field reached by handleClearTerminal.
      {
        client,
        clientRef,
        showToast,
        getTerminalRef: () => currentTerminal,
        unsubscribeTerminal,
        subscribeToTerminal,
        terminalUnsubsRef
      } as unknown as Parameters<typeof useMobileSessionTerminalInput>[0]
    )
    return null
  }
  let renderer: ReturnType<typeof create> | undefined
  act(() => {
    renderer = create(createElement(Harness))
  })
  return {
    clear,
    showToast,
    unsubscribeTerminal,
    subscribeToTerminal,
    clearHost: () =>
      actions?.handleClearTerminal({
        handle: 'term',
        title: 'Shell',
        isActive: true
      }),
    replaceTerminal: () => {
      currentTerminal = { clear: vi.fn() }
    },
    migrateAuthority: () => {
      generation += 1
    },
    replaceClient: () => {
      clientRef.current = { ...client }
    },
    dispose: () => act(() => renderer?.unmount())
  }
}

function deferredReply() {
  let resolve: (reply: RpcResponse) => void = () => {}
  const promise = new Promise<RpcResponse>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const cleared: RpcResponse = {
  id: 'clear',
  ok: true,
  result: { clear: { handle: 'term', cleared: true } }
}

describe('mobile terminal buffer clear acknowledgement', () => {
  it.each([
    {
      id: 'refused',
      ok: false,
      error: { code: 'not_found', message: 'Terminal missing' }
    },
    {
      id: 'not-cleared',
      ok: true,
      result: { clear: { handle: 'term', cleared: false } }
    },
    { id: 'incompatible', ok: true, result: {} }
  ] satisfies RpcResponse[])(
    'preserves local output when the host does not clear it: $id',
    async (reply) => {
      const view = mountClear(async () => reply)
      try {
        await view.clearHost()
        expect(view.clear).not.toHaveBeenCalled()
        expect(view.subscribeToTerminal).not.toHaveBeenCalled()
        expect(view.showToast.mock.calls).toEqual([["Couldn't clear terminal", 1500]])
      } finally {
        view.dispose()
      }
    }
  )

  it('refreshes the ordered host snapshot after acknowledgement instead of erasing current output', async () => {
    const reply = deferredReply()
    const view = mountClear(() => reply.promise)
    try {
      const pending = view.clearHost()
      expect(view.subscribeToTerminal).not.toHaveBeenCalled()
      expect(view.showToast).not.toHaveBeenCalled()
      reply.resolve(cleared)
      await pending
      expect(view.clear).not.toHaveBeenCalled()
      expect(view.unsubscribeTerminal).toHaveBeenCalledWith('term')
      expect(view.subscribeToTerminal).toHaveBeenCalledWith('term')
      expect(view.showToast.mock.calls).toEqual([['Terminal cleared']])
    } finally {
      view.dispose()
    }
  })

  it('leaves an unsubscribed tab to draw its snapshot when it next subscribes', async () => {
    const view = mountClear(async () => cleared, { subscribed: false })
    try {
      await view.clearHost()
      expect(view.subscribeToTerminal).not.toHaveBeenCalled()
      expect(view.showToast.mock.calls).toEqual([['Terminal cleared']])
    } finally {
      view.dispose()
    }
  })

  it.each(['replaceTerminal', 'migrateAuthority'] as const)(
    'still refreshes when the clear is accepted after %s',
    async (change) => {
      const reply = deferredReply()
      const view = mountClear(() => reply.promise)
      try {
        const pending = view.clearHost()
        view[change]()
        reply.resolve(cleared)
        await pending
        expect(view.subscribeToTerminal).toHaveBeenCalledWith('term')
        expect(view.showToast.mock.calls).toEqual([['Terminal cleared']])
      } finally {
        view.dispose()
      }
    }
  )

  it('ignores a clear acknowledgement after the client is replaced', async () => {
    const reply = deferredReply()
    const view = mountClear(() => reply.promise)
    try {
      const pending = view.clearHost()
      view.replaceClient()
      reply.resolve(cleared)
      await pending
      expect(view.clear).not.toHaveBeenCalled()
      expect(view.subscribeToTerminal).not.toHaveBeenCalled()
      expect(view.showToast).not.toHaveBeenCalled()
    } finally {
      view.dispose()
    }
  })
})
