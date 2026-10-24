import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient, rpcSuccess } from '../mobile-web-shell/bridge-host-test-fakes'
import { useMobileBrowserCommands } from './use-mobile-browser-commands'
import { useMobileBrowserRequest } from './use-mobile-browser-request'
import { createStableLogicalRpcClient } from '../transport/stable-logical-rpc-client'

function mountKeyboard() {
  const client = createFakeRpcClient()
  const logicalClient = createStableLogicalRpcClient(client, 'relay')
  const toast = vi.fn()
  let pageId = 'page-1'
  let renderer: ReactTestRenderer
  let value = ''
  let edit: (text: string) => void = () => {}
  let send: () => Promise<void> = async () => {}
  function Keyboard() {
    const [draft, setDraft] = useState('first draft')
    const request = useMobileBrowserRequest({
      busyRef: { current: false },
      client: logicalClient,
      pageId,
      worktreeId: 'tree-1',
      setBusy: () => {},
      setError: () => {}
    })
    const commands = useMobileBrowserCommands({
      client: logicalClient,
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
    switchPage: () =>
      act(() => {
        pageId = 'page-2'
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
            request.reject(new Error('Connection migrated'))
          }
          await pending
        })
        expect(keyboard.draft()).toBe(accepted ? 'new typing' : 'first draftnew typing')
        expect(keyboard.toast.mock.calls).toEqual([
          [accepted ? 'Sent' : 'Could not confirm delivery. Check the page before retrying.']
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
    expect(keyboard.toast).not.toHaveBeenCalledWith('Sent')
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

  it('does not restore a refused send into a different page draft', async () => {
    const keyboard = mountKeyboard()
    let pending: Promise<void>
    act(() => {
      pending = keyboard.send()
    })
    keyboard.switchPage()
    act(() => keyboard.edit('page two'))
    await act(async () => {
      keyboard.client.requests[0]!.reject(new Error('Disconnected'))
      await pending
    })
    expect(keyboard.draft()).toBe('page two')
    expect(keyboard.toast).not.toHaveBeenCalled()
    keyboard.unmount()
  })
})
