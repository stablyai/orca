import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient, rpcSuccess } from '../mobile-web-shell/bridge-host-test-fakes'
import { useMobileBrowserCommands } from './use-mobile-browser-commands'
import { useMobileBrowserRequest } from './use-mobile-browser-request'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { createStableLogicalRpcClient } from '../transport/stable-logical-rpc-client'

function mountKeyboard() {
  const client = createFakeRpcClient()
  const logicalClient = createStableLogicalRpcClient(client, 'relay')
  const toast = vi.fn()
  let activeClient = logicalClient
  let renderer: ReactTestRenderer
  let value = ''
  let edit: (text: string) => void = () => {}
  let send: () => Promise<void> = async () => {}
  function Keyboard() {
    const [draft, setDraft] = useState('first draft')
    const request = useMobileBrowserRequest({
      busyRef: { current: false },
      client: activeClient,
      pageId: 'page-1',
      worktreeId: 'tree-1',
      setBusy: () => {},
      setError: () => {}
    })
    const commands = useMobileBrowserCommands({
      client: activeClient,
      frameMetadataRef: { current: null },
      keyboardValue: draft,
      layoutRef: { current: null },
      onToast: toast,
      ...request,
      pointerModifiers: [],
      setDialog: () => {},
      setError: () => {},
      setKeyboardValue: setDraft,
      setPointerModifiers: () => {},
      zoomRef: { current: { scale: 1, offsetX: 0, offsetY: 0 } }
    })
    value = draft
    edit = setDraft
    send = commands.sendKeyboardText
    return null
  }
  act(() => {
    renderer = create(createElement(Keyboard))
  })
  return {
    client,
    toast,
    draft: () => value,
    edit: (text: string) => edit(text),
    send: () => send(),
    migrateConnection: async () => {
      await act(async () => {
        await logicalClient.migrateTo(createFakeRpcClient(), 'lan')
        renderer.update(createElement(Keyboard))
      })
    },
    reconnect: () =>
      act(() => {
        activeClient = createStableLogicalRpcClient(createFakeRpcClient(), 'relay')
        renderer.update(createElement(Keyboard))
      }),
    unmount: () => act(() => renderer.unmount())
  }
}

describe('browser keyboard draft delivery', () => {
  it.each([true, false])(
    'preserves newer typing across a same-computer connection migration: accepted=%s',
    async (accepted) => {
      const keyboard = mountKeyboard()
      try {
        let pending: Promise<void> | undefined
        act(() => {
          pending = keyboard.send()
        })
        act(() => keyboard.edit('new typing'))
        await keyboard.migrateConnection()
        expect(keyboard.draft()).toBe('new typing')
        await act(async () => {
          const request = keyboard.client.requests[0]!
          if (accepted) {
            request.resolve(rpcSuccess('send', null))
          } else {
            request.reject(markRpcDeliveryUnknown(new Error('Connection migrated')))
          }
          await pending
        })
        expect(keyboard.draft()).toBe(accepted ? 'new typing' : 'first draftnew typing')
        expect(keyboard.toast.mock.calls).toEqual([
          [accepted ? 'Sent' : 'Delivery unconfirmed — check page before retrying']
        ])
      } finally {
        keyboard.unmount()
      }
    }
  )

  it('retains newer typing when an earlier send is refused', async () => {
    const keyboard = mountKeyboard()
    let pending: Promise<void>
    act(() => {
      pending = keyboard.send()
    })
    act(() => keyboard.edit('new draft'))
    await act(async () => {
      keyboard.client.requests[0]!.resolve({
        id: 'send',
        ok: false,
        error: { code: 'refused', message: 'Read only' }
      })
      await pending
    })
    expect(keyboard.draft()).toBe('first draftnew draft')
    expect(keyboard.toast).not.toHaveBeenCalled()
    keyboard.unmount()
  })

  it('clears acknowledged text even when the host returns a null result', async () => {
    const keyboard = mountKeyboard()
    let pending: Promise<void>
    act(() => {
      pending = keyboard.send()
    })
    await act(async () => {
      keyboard.client.requests[0]!.resolve(rpcSuccess('send', null))
      await pending
    })
    expect(keyboard.draft()).toBe('')
    expect(keyboard.toast).toHaveBeenCalledWith('Sent')
    keyboard.unmount()
  })

  it('submits once for repeated presses and preserves edits made during delivery', async () => {
    const keyboard = mountKeyboard()
    let pending: Promise<void>
    act(() => {
      pending = keyboard.send()
      void keyboard.send()
    })
    expect(keyboard.client.requests).toHaveLength(1)
    expect(keyboard.draft()).toBe('')
    act(() => keyboard.edit('next draft'))
    await act(async () => {
      keyboard.client.requests[0]!.resolve(rpcSuccess('send', {}))
      await pending
    })
    expect(keyboard.draft()).toBe('next draft')
    keyboard.unmount()
  })

  it('sends newer typing while an earlier send is still in flight', async () => {
    const keyboard = mountKeyboard()
    let first: Promise<void>
    let second: Promise<void>
    act(() => {
      first = keyboard.send()
    })
    act(() => keyboard.edit('next draft'))
    act(() => {
      second = keyboard.send()
    })
    expect(keyboard.client.requests.map((request) => request.args[1])).toMatchObject([
      { text: 'first draft' },
      { text: 'next draft' }
    ])
    await act(async () => {
      keyboard.client.requests[0]!.resolve(rpcSuccess('send', {}))
      keyboard.client.requests[1]!.resolve(rpcSuccess('send', {}))
      await Promise.all([first, second])
    })
    expect(keyboard.draft()).toBe('')
    keyboard.unmount()
  })

  it('restores unconfirmed text after a reconnect replaces the client', async () => {
    const keyboard = mountKeyboard()
    let pending: Promise<void>
    act(() => {
      pending = keyboard.send()
    })
    keyboard.reconnect()
    act(() => keyboard.edit('after reconnect'))
    await act(async () => {
      keyboard.client.requests[0]!.reject(markRpcDeliveryUnknown(new Error('Request timed out')))
      await pending
    })
    expect(keyboard.draft()).toBe('first draftafter reconnect')
    expect(keyboard.toast.mock.calls).toEqual([
      ['Delivery unconfirmed — check page before retrying']
    ])
    keyboard.unmount()
  })
})
