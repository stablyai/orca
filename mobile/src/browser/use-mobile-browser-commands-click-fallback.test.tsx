/**
 * When a tap's `browser.mouseClick` fails, the pane replays it as move/down/up. That is only safe
 * when the host definitely did not run the click: a timed-out one is still queued there, and
 * replaying it lands a second tap on whatever the first one opened.
 */
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileBrowserCommands } from './use-mobile-browser-commands'
import { useMobileBrowserRequest } from './use-mobile-browser-request'

const { sent, clickFailure, clickReply } = vi.hoisted(() => {
  const failure: { current: Error | null } = { current: null }
  const reply: { current: unknown } = { current: {} }
  return { sent: new Array<string>(), clickFailure: failure, clickReply: reply }
})

vi.mock('./mobile-browser-command-operations', () => {
  const command = (method: string) => ({
    request: vi.fn(async () => {
      sent.push(method)
      if (method === 'browser.mouseClick') {
        if (clickFailure.current) {
          throw clickFailure.current
        }
        return clickReply.current
      }
      return {}
    }),
    interpret: (reply: unknown) => reply
  })
  return {
    browserDialogAccept: command('browser.dialogAccept'),
    browserDialogDismiss: command('browser.dialogDismiss'),
    browserInsertText: command('browser.keyboardInsertText'),
    browserKeypress: command('browser.keypress'),
    browserPointerClick: command('browser.mouseClick'),
    browserPointerDown: command('browser.mouseDown'),
    browserPointerMove: command('browser.mouseMove'),
    browserPointerUp: command('browser.mouseUp'),
    browserPointerWheel: command('browser.mouseWheel')
  }
})

type Commands = ReturnType<typeof useMobileBrowserCommands>

function mountCommands(): Commands {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the operations module is mocked, so the client is only passed through and never called.
  const client = {} as RpcClient
  const held: { commands: Commands | null } = { commands: null }
  function Screen(): null {
    const { pageParams, sendBrowserRequest } = useMobileBrowserRequest({
      busyRef: { current: false },
      client,
      pageId: 'page-1',
      setBusy: () => {},
      setError: () => {},
      worktreeId: 'wt-1'
    })
    held.commands = useMobileBrowserCommands({
      client,
      frameMetadataRef: { current: null },
      keyboardValue: '',
      layoutRef: { current: null },
      onToast: () => {},
      pageParams,
      pointerModifiers: [],
      sendBrowserRequest,
      setDialog: () => {},
      setError: () => {},
      setKeyboardValue: () => {},
      setPointerModifiers: () => {},
      zoomRef: { current: { scale: 1, offsetX: 0, offsetY: 0 } }
    })
    return null
  }
  act(() => {
    create(createElement(Screen))
  })
  if (!held.commands) {
    throw new Error('nothing mounted')
  }
  return held.commands
}

describe('tap fallback', () => {
  beforeEach(() => {
    sent.length = 0
    clickFailure.current = null
    clickReply.current = {}
  })

  it('does not replay a click whose delivery is unknown', async () => {
    clickFailure.current = markRpcDeliveryUnknown(
      new Error('Request timed out: browser.mouseClick')
    )
    const commands = mountCommands()

    await act(async () => {
      await commands.sendPointerClick({ x: 10, y: 20 }, 'left')
    })

    expect(sent).toEqual(['browser.mouseClick'])
  })

  // The external-Chromium provider answers a delivered click with agent-browser's `data`, which can be null.
  it('does not replay a click the host answered, whatever the answer', async () => {
    clickReply.current = null
    const commands = mountCommands()

    await act(async () => {
      await commands.sendPointerClick({ x: 10, y: 20 }, 'right')
    })

    expect(sent).toEqual(['browser.mouseClick'])
  })

  it('replays a click the host refused as move, down and up', async () => {
    clickFailure.current = new Error('Unknown method: browser.mouseClick')
    const commands = mountCommands()

    await act(async () => {
      await commands.sendPointerClick({ x: 10, y: 20 }, 'left')
    })

    expect(sent).toEqual([
      'browser.mouseClick',
      'browser.mouseMove',
      'browser.mouseDown',
      'browser.mouseUp'
    ])
  })
})
