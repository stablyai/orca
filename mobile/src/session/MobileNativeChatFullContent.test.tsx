import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { RpcClient } from '../transport/rpc-client'
import { MobileNativeChatItemSourceContext } from './mobile-native-chat-item-read'
import { useMobileNativeChatFullMessage } from './MobileNativeChatFullContent'
import { MobileNativeChatUserMessageFold } from './MobileNativeChatUserMessageFold'

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
const message: NativeChatMessage = {
  id: 'message',
  role: 'assistant',
  source: 'transcript',
  timestamp: 1,
  shortened: true,
  blocks: [{ type: 'text', text: 'head' }]
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only client identity is used; this fixture performs no RPC.
const first = {} as RpcClient
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only client identity is used; this fixture performs no RPC.
const second = {} as RpcClient
let renderer: ReactTestRenderer | undefined
afterEach(() => {
  act(() => renderer?.unmount())
})
function Probe() {
  return useMobileNativeChatFullMessage(message).showFull
}

it.each(['client', 'session'] as const)(
  'keeps a pending or failed request with its original %s owner',
  async (changed) => {
    const pending = Promise.withResolvers<void>()
    const oldLoad = vi.fn(() => pending.promise)
    const newLoad = vi.fn(async () => {})
    const source = (client: RpcClient, sessionId: string, load: () => Promise<void>) => ({
      client,
      sessionId,
      messageDetail: { raw: () => message, state: () => 'available' as const, load }
    })
    const render = (value: ReturnType<typeof source>) =>
      createElement(MobileNativeChatItemSourceContext.Provider, { value }, createElement(Probe))
    await act(async () => {
      renderer = create(render(source(first, 'session', oldLoad)))
    })
    const button = () => renderer?.root.findByProps({ accessibilityRole: 'button' })
    await act(async () => {
      button()?.props.onPress()
    })
    expect(button()?.props.disabled).toBe(true)
    await act(async () => {
      renderer?.update(
        render(
          source(
            changed === 'client' ? second : first,
            changed === 'session' ? 'other' : 'session',
            newLoad
          )
        )
      )
    })
    expect(button()?.props.disabled).toBe(false)
    await act(async () => {
      pending.reject(new Error('old host failed'))
      await pending.promise.catch(() => {})
    })
    expect(JSON.stringify(renderer?.toJSON())).not.toContain("couldn't load")
    await act(async () => {
      button()?.props.onPress()
    })
    expect(newLoad).toHaveBeenCalledOnce()
  }
)

it('opens and retries missing user text without losing local disclosure', async () => {
  let text = 'head\n'.repeat(200)
  const raw: NativeChatMessage = { ...message, role: 'user', blocks: [{ type: 'text', text }] }
  let pending = Promise.withResolvers<void>()
  const load = vi.fn(() =>
    pending.promise.then(() => {
      text += 'FULL TAIL'
    })
  )
  const value = {
    client: first,
    sessionId: 'session',
    messageDetail: {
      raw: () => raw,
      state: () => (text.endsWith('FULL TAIL') ? ('complete' as const) : ('available' as const)),
      load
    }
  }
  function UserProbe() {
    const [open, setOpen] = useState(false)
    const full = useMobileNativeChatFullMessage({ ...raw, blocks: [{ type: 'text', text }] })
    return (
      <MobileNativeChatUserMessageFold
        text={text}
        fontScale={1}
        open={open}
        onToggle={() => setOpen((held) => !held)}
        recovery={full.recovery}
        status={full.showFull}
      >
        {createElement('Text', null, text)}
      </MobileNativeChatUserMessageFold>
    )
  }
  await act(async () => {
    renderer = create(
      createElement(MobileNativeChatItemSourceContext.Provider, { value }, createElement(UserProbe))
    )
  })
  await act(async () => {
    renderer?.root
      .find((node) => typeof node.props.onLayout === 'function')
      .props.onLayout({ nativeEvent: { layout: { height: 400 } } })
  })
  const buttons = () => renderer?.root.findAllByProps({ accessibilityRole: 'button' }) ?? []
  const press = async (index = 0) => {
    await act(async () => {
      buttons()[index].props.onPress()
    })
  }
  expect(buttons()).toHaveLength(1)
  await press()
  expect(buttons()[0].props.accessibilityState.expanded).toBe(true)
  expect(load).toHaveBeenCalledOnce()
  await act(async () => {
    pending.reject(new Error('host unavailable'))
    await pending.promise.catch(() => {})
  })
  expect(JSON.stringify(renderer?.toJSON())).toContain('head')
  expect(JSON.stringify(renderer?.toJSON())).toContain("couldn't load")
  pending = Promise.withResolvers<void>()
  await press(1)
  expect(buttons()[0].props.accessibilityState.expanded).toBe(true)
  await act(async () => {
    pending.resolve()
    await pending.promise
  })
  expect(JSON.stringify(renderer?.toJSON())).toContain('FULL TAIL')
  expect(buttons()).toHaveLength(1)
  await press()
  expect(buttons()[0].props.accessibilityState.expanded).toBe(false)
  await press()
  expect(buttons()[0].props.accessibilityState.expanded).toBe(true)
  expect(load).toHaveBeenCalledTimes(2)
})
