import { createElement } from 'react'
import { Text } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { MobileSpeechSetup } from '../mobile-dictation-setup'
import { ListRow } from '../../components/list/ListGroup'
import { MobileDictationSetupSheet } from './MobileDictationSetupSheet'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'web', select: (values: { default?: unknown }) => values.default },
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) }
}))
vi.mock('lucide-react-native', () => ({ Check: 'Check', Cloud: 'Cloud', Download: 'Download' }))
vi.mock('../../components/bottom-drawer/BottomDrawer', () => ({ BottomDrawer: 'Drawer' }))
vi.mock('../../components/controls/MobileSwitch', () => ({ MobileSwitch: 'Switch' }))
// Mock factories run before static imports initialize.
vi.mock(
  '../../components/list/ListGroup',
  async () => (await import('../../test-support/settings-chrome-test-double')).listGroupDouble
)

let renderer: ReactTestRenderer | undefined
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  vi.useRealTimers()
})

function clientWith(sendRequest: RpcClient['sendRequest']): RpcClient {
  return {
    sendRequest,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport() {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 0,
    onStateChange: () => () => {},
    notifyForeground() {},
    close() {}
  }
}

async function open(client: RpcClient): Promise<void> {
  await act(async () => {
    renderer = create(
      createElement(MobileDictationSetupSheet, { visible: true, client, onClose() {} })
    )
  })
}

it('recovers download progress after the post-download setup read fails', async () => {
  let started = false
  let failed = false
  let completed = false
  const client = clientWith(async (method) => {
    if (method === 'speech.models.download') {
      started = true
      return { id: 'reply', ok: true, result: {} }
    }
    if (started && !failed) {
      failed = true
      throw new Error('Setup connection interrupted')
    }
    return {
      id: 'reply',
      ok: true,
      result: {
        models: [
          {
            id: 'local',
            label: 'Local',
            status: completed ? 'ready' : started ? 'downloading' : 'not-downloaded'
          }
        ]
      }
    }
  })
  await open(client)
  await act(async () => {
    renderer!.root.findByProps({ accessibilityLabel: 'Download Local' }).props.onPress()
  })
  expect(renderer!.root.findAllByProps({ accessibilityLabel: 'Download Local' })).toHaveLength(0)
  completed = true
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500)
  })
  expect(renderer!.root.findByProps({ accessibilityLabel: 'Use Local' })).toBeDefined()
})

it('reconciles a committed account write with a lost reply without hiding the error', async () => {
  let setup: MobileSpeechSetup = {
    models: [{ id: 'chatgpt', provider: 'chatgpt', status: 'ready' }],
    chatGptAccountId: 'personal',
    chatGptAccounts: [
      { id: 'personal', label: 'Personal' },
      { id: 'work', label: 'Work' }
    ]
  }
  const client = clientWith(async (method) => {
    if (method === 'speech.dictation.setup') {
      setup = { ...setup, chatGptAccountId: 'work' }
      throw new Error('Account reply lost')
    }
    return { id: 'reply', ok: true, result: setup }
  })
  await open(client)
  const work = () =>
    renderer!.root.findAllByType(ListRow).find((row) => row.props.title === 'Work')!
  await act(async () => {
    work().props.onPress()
  })
  expect(work().props.selected).toBe(true)
  expect(
    renderer!.root.findAllByType(Text).some((node) => node.props.children === 'Account reply lost')
  ).toBe(true)
})
