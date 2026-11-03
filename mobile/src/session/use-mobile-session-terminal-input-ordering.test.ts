import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { useMobileSessionTerminalInput } from './use-mobile-session-terminal-input'
import { MobileTerminalInputSender } from '../terminal/mobile-terminal-input-sender'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { RpcResponse } from '../transport/types'

it('sends validated TUI scroll batches through the same bounded ordered owner while earlier replies are held', async () => {
  const sent: unknown[] = []
  const replies: Array<(value: RpcResponse) => void> = []
  const client = stubRpcClient({
    sendRequest: (method, params, options) => {
      options?.beforeSend?.()
      if (method === 'terminal.openInputSession') {
        return Promise.resolve({ id: 'open', ok: true, result: { inputSessionId: 'session' } })
      }
      sent.push(params)
      return new Promise<RpcResponse>((resolve) => replies.push(resolve))
    }
  })
  const sender = new MobileTerminalInputSender()
  let input!: ReturnType<typeof useMobileSessionTerminalInput>['handleTerminalInput']
  const sendTerminalOrderedInput: Parameters<
    typeof useMobileSessionTerminalInput
  >[0]['sendTerminalOrderedInput'] = (_rpc, params, options, enqueue) =>
    sender.request(client, params, options, true, enqueue)
  const scope = {
    client,
    connState: 'connected',
    activeHandleRef: { current: 'term' },
    activeSessionTabTypeRef: { current: 'terminal' },
    clientRef: { current: client },
    connStateRef: { current: 'connected' },
    deviceTokenRef: { current: 'phone' },
    ptyModesRef: { current: new Map([['term', { altScreen: true }]]) },
    terminalGestureInputBucketsRef: { current: new Map() },
    terminalGestureInputQueuesRef: { current: new Map() },
    terminalGestureInputInFlightRef: { current: new Set() },
    sendTerminalOrderedInput
  }
  function Harness() {
    input = useMobileSessionTerminalInput(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness exercises only handleTerminalInput, with every field it reads supplied above.
      scope as unknown as Parameters<typeof useMobileSessionTerminalInput>[0]
    ).handleTerminalInput
    return null
  }
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(createElement(Harness))
  })
  try {
    await input('term', '\x1b[B')
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    await input('term', '\x1b[B')
    await input('term', '\x1b[B')
    await input('other', '\x1b[B')
    await input('term', 'untrusted')
    expect(sent).toEqual(
      [1, 2, 3].map((seq) => ({
        terminal: 'term',
        text: '\x1b[B',
        enter: false,
        client: { id: 'phone', type: 'mobile' },
        inputSequence: { sessionId: 'session', seq }
      }))
    )
    replies
      .splice(0)
      .forEach((reply) => reply({ id: 'send', ok: true, result: { send: { accepted: true } } }))
  } finally {
    act(() => renderer.unmount())
    sender.cancelAll()
  }
})
