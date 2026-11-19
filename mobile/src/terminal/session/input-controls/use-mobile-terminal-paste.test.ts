import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { TerminalModes } from '../../webview/terminal-webview-contract'
import { useMobileTerminalPaste } from './use-mobile-terminal-paste'

const clipboardText = vi.hoisted(() => ({ value: '' }))
vi.mock('../../../platform/clipboard/clipboard', () => ({
  useClipboardReader: () => ({
    readText: () => Promise.resolve(clipboardText.value),
    readImage: () => Promise.resolve(null),
    contents: () => Promise.resolve({ text: true, image: false })
  })
}))

const BRACKETED: TerminalModes = {
  bracketedPasteMode: true,
  altScreen: false,
  mouseTrackingMode: 'none',
  sgrMouseMode: false,
  sgrMousePixelsMode: false,
  applicationCursorKeysMode: false,
  kittyKeyboardFlags: 0,
  modifyOtherKeys: 0
}

type PasteOptions = Parameters<typeof useMobileTerminalPaste>[0]

async function pasteInto(accept: (text: string, index: number) => boolean): Promise<string[]> {
  const sent: string[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook only hands the client to the stubbed send and reads its connection epoch.
  const client = { getLastConnectedAt: () => 1 } as unknown as RpcClient
  const sendTerminalUserInput: PasteOptions['sendTerminalUserInput'] = (_client, params) => {
    const index = sent.push(params.text ?? '') - 1
    return Promise.resolve({
      id: String(index),
      ok: true as const,
      result: { send: { accepted: accept(params.text ?? '', index) } }
    })
  }
  let paste: (() => Promise<void>) | undefined
  function Probe() {
    paste = useMobileTerminalPaste({
      sendTerminalUserInput,
      activeHandle: 'terminal-1',
      activeHandleRef: { current: 'terminal-1' },
      activeSessionTabTypeRef: { current: 'terminal' },
      canSend: true,
      client,
      clientRef: { current: client },
      connState: 'connected',
      connStateRef: { current: 'connected' },
      deviceTokenRef: { current: 'device-1' },
      flushPendingLiveInputBeforeExternalSend: () => Promise.resolve(true),
      getActiveWorktreeConnectionId: () => Promise.resolve(null),
      onError: () => {},
      onSuccess: () => {},
      ptyModesRef: { current: new Map([['terminal-1', BRACKETED]]) },
      refreshCanPaste: () => {},
      showToast: () => {}
    })
    return null
  }
  act(() => {
    create(createElement(Probe))
  })
  await paste!()
  return sent
}

describe('useMobileTerminalPaste', () => {
  it('sends a paste over 256 KiB as ordered chunks of one bracketed frame', async () => {
    clipboardText.value = 'a'.repeat(300 * 1024)
    const sent = await pasteInto(() => true)
    expect(sent.map((text) => text.length)).toEqual([
      64 * 1024,
      64 * 1024,
      64 * 1024,
      64 * 1024,
      44 * 1024 + 12
    ])
    expect(sent.join('')).toBe(`\x1b[200~${clipboardText.value}\x1b[201~`)
  })

  it('stops at a refused chunk and closes the bracketed frame', async () => {
    clipboardText.value = 'b'.repeat(300 * 1024)
    const sent = await pasteInto((_text, index) => index !== 1)
    expect(sent).toHaveLength(3)
    expect(sent[2]).toBe('\x1b[201~')
  })
})
