import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { resetWorkerTerminalTakeoverReportsForTest } from '../terminal/worker-terminal-takeover-report'
import { useMobileSessionTerminalSendActions } from './use-mobile-session-terminal-send-actions'
import { useMobileSessionTerminalInput } from './use-mobile-session-terminal-input'
import { useMobileTerminalPaste } from './use-mobile-terminal-paste'
import { useTerminalLiveInputCommit } from '../terminal/use-terminal-live-input-commit'
import { routeDictationTranscript } from '../terminal/terminal-live-dictation-routing'
import {
  sendMobileNativeChatMessageWithOutcome,
  clearMobileNativeChatInput
} from './mobile-native-chat-send'
import { sendMobileTerminalQueryReply } from '../terminal/mobile-terminal-query-reply'
import { createTerminalAndSendPrompt } from './pr-ai-triage-launch'
import { useMobileDiffReviewSendActions } from './use-mobile-diff-review-send-actions'
import { pasteMobileNativeChatImagePaths } from './mobile-native-chat-image-send'

vi.mock('react-native', () => ({ Keyboard: { dismiss: vi.fn() } }))
vi.mock('../platform/haptics', () => ({ triggerError: vi.fn(), triggerSuccess: vi.fn() }))
vi.mock('expo-clipboard', () => ({ getStringAsync: async () => 'pasted text' }))
vi.mock('expo-file-system', () => ({ File: class {}, Paths: { cache: '/tmp' } }))
vi.mock('expo-image-manipulator', () => ({ ImageManipulator: {}, SaveFormat: {} }))

const REPORT = 'orchestration.workerTerminalUserInput'
const ref = <T>(current: T) => ({ current })
const renderers: ReactTestRenderer[] = []
function clientFixture() {
  return {
    sendRequest: vi.fn(async (method: string) => ({
      id: 'rpc',
      ok: true as const,
      result:
        method === 'session.tabs.createTerminal'
          ? { tab: { type: 'terminal', id: 'tab', terminal: 'term-1', title: 'test' } }
          : method === REPORT
            ? { changed: 1 }
            : { send: { accepted: true } }
    }))
  }
}

function mountSendSites(client: ReturnType<typeof clientFixture>, handle = 'term-1') {
  const activeHandleRef = ref<string | null>(handle)
  const activeSessionTabTypeRef = ref<string | null>('terminal')
  const sendLiveTerminalInputRef = ref(async (_handle: string, _text: string) => false)
  const scope = {
    client,
    clientRef: ref(client),
    activeHandle: handle,
    activeHandleRef,
    activeSessionTabTypeRef,
    connState: 'connected',
    connStateRef: ref('connected'),
    activeSessionTab: { type: 'terminal', terminal: handle },
    sendingRef: ref(false),
    canSend: true,
    deviceTokenRef: ref('phone'),
    liveInputRef: ref(null),
    commandInputRef: ref(null),
    liveInputFocusTimerRef: ref(null),
    sendLiveTerminalInputRef,
    getSendCompletionGeneration: () => 0,
    showToast: vi.fn(),
    ptyModesRef: ref(new Map([[handle, { altScreen: true }]])),
    terminalGestureInputBucketsRef: ref(new Map()),
    terminalGestureInputQueuesRef: ref(new Map()),
    terminalGestureInputInFlightRef: ref(new Set()),
    bufferedTerminalDraftState: {
      input: 'command',
      beginBufferedTerminalDraftSend: vi.fn(),
      restoreRejectedDraft: vi.fn(),
      settleBufferedTerminalDraftSend: () => true
    }
  }
  let actions!: ReturnType<typeof useMobileSessionTerminalSendActions>
  let live!: ReturnType<typeof useTerminalLiveInputCommit>
  let gestures!: ReturnType<typeof useMobileSessionTerminalInput>
  let paste!: ReturnType<typeof useMobileTerminalPaste>
  let diff!: ReturnType<typeof useMobileDiffReviewSendActions>
  function Harness() {
    live = useTerminalLiveInputCommit({
      activeHandle: handle,
      activeHandleRef,
      activeSessionTabType: 'terminal',
      activeSessionTabTypeRef,
      connected: true,
      liveInputRef: ref(null),
      liveInputTerminalHandles: new Set([handle]),
      liveInputTerminalHandlesRef: ref(new Set([handle])),
      sendLiveTerminalInputRef,
      setLiveInputCapture: vi.fn()
    })
    actions = useMobileSessionTerminalSendActions({
      ...scope,
      handleLiveInputAccessoryBytes: live.handleLiveInputAccessoryBytes
    } as never)
    gestures = useMobileSessionTerminalInput(scope as never)
    paste = useMobileTerminalPaste({
      ...scope,
      flushPendingLiveInputBeforeExternalSend: live.flushPendingLiveInputBeforeExternalSend,
      getActiveWorktreeConnectionId: async () => null,
      onError: vi.fn(),
      onSuccess: vi.fn(),
      refreshCanPaste: vi.fn()
    } as never)
    diff = useMobileDiffReviewSendActions({
      client: client as unknown as RpcClient,
      connState: 'connected',
      worktreeId: 'workspace',
      screenState: { kind: 'loading' },
      setActionError: vi.fn(),
      setSendSheet: vi.fn(),
      saveCommentsAndReviewState: vi.fn()
    } as never)
    return null
  }
  act(() => {
    renderers.push(create(createElement(Harness)))
  })
  let text = ''
  return {
    'live field': async () => {
      text += 'x'
      live.handleLiveInputChange({ nativeEvent: { text, isComposing: false } })
      await live.flushPendingLiveInputBeforeExternalSend(handle)
    },
    'live submit': () => live.handleLiveInputSubmit(),
    'live accessory': async () => {
      live.handleLiveInputChange({ nativeEvent: { text: 'composing', isComposing: true } })
      await live.handleLiveInputAccessoryBytes({ bytes: '\x1b[A' })
    },
    'raw accessory': () => actions.handleAccessoryKey({ bytes: '\x1b[A' } as never),
    'buffered submit': () => actions.handleSend(),
    'gesture arrows': async () => {
      await gestures.handleTerminalInput(handle, '\x1b[A')
      await gestures.flushTerminalGestureInput(handle)
    },
    paste: () => paste(),
    dictation: async () => {
      const route = routeDictationTranscript('dictated text', true)
      expect(route.kind).toBe('live-insert')
      await actions.sendLiveTerminalInput(handle, route.text)
    },
    'native chat': () =>
      sendMobileNativeChatMessageWithOutcome({
        client: client as unknown as RpcClient,
        terminal: handle,
        text: 'hello'
      }),
    'query reply': () =>
      sendMobileTerminalQueryReply({
        bytes: '\x1b[0n',
        client,
        clientId: 'phone',
        connected: true,
        handle,
        hostSupportsQueryReplyInput: true,
        subscribedTerminals: new Set([handle])
      }),
    'image heal': () =>
      clearMobileNativeChatInput({
        client: client as unknown as RpcClient,
        terminal: handle,
        clearInput: '\x15'
      }),
    'image attachment': () =>
      pasteMobileNativeChatImagePaths({
        client,
        terminal: handle,
        deviceToken: 'phone',
        imagePaths: ['/tmp/picture.png'],
        followedByText: true
      }),
    'PR triage': () => createTerminalAndSendPrompt(client, 'workspace', 'fix checks'),
    'diff review': () => diff.sendPromptToTerminal(handle, []),
    programmatic: () => client.sendRequest('terminal.send')
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  resetWorkerTerminalTakeoverReportsForTest()
})
afterEach(() => {
  act(() => {
    for (const renderer of renderers.splice(0)) {
      renderer.unmount()
    }
  })
  vi.useRealTimers()
})

const realSites = [
  'live field',
  'live submit',
  'live accessory',
  'raw accessory',
  'buffered submit',
  'gesture arrows',
  'paste',
  'dictation',
  'native chat'
] as const
it.each(realSites)('%s reports on its send target once per handle per 30 seconds', async (site) => {
  const client = clientFixture()
  const sites = mountSendSites(client)
  const invoke = async () => {
    await act(async () => {
      await sites[site]()
    })
  }
  const reports = () => client.sendRequest.mock.calls.filter(([method]) => method === REPORT)
  await invoke()
  await invoke()
  expect(
    client.sendRequest.mock.calls.filter(([method]) => method === 'terminal.send').length
  ).toBeGreaterThanOrEqual(2)
  expect(reports()).toHaveLength(1)
  expect(reports()[0]).toEqual([REPORT, { terminal: 'term-1' }, expect.any(Object)])
  await vi.advanceTimersByTimeAsync(29_999)
  await invoke()
  expect(reports()).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  await invoke()
  expect(reports()).toHaveLength(2)
  const other = mountSendSites(client, 'term-2')
  await act(async () => {
    await other[site]()
  })
  expect(reports()).toHaveLength(3)
  expect(reports()[2][1]).toEqual({ terminal: 'term-2' })
})

it.each([
  'query reply',
  'image heal',
  'image attachment',
  'PR triage',
  'diff review',
  'programmatic'
] as const)('%s never reports takeover', async (site) => {
  const client = clientFixture()
  const sites = mountSendSites(client)
  await act(async () => {
    await sites[site]()
    await sites[site]()
  })
  expect(client.sendRequest.mock.calls.some(([method]) => method === 'terminal.send')).toBe(true)
  expect(client.sendRequest.mock.calls.filter(([method]) => method === REPORT)).toHaveLength(0)
})

it.each(realSites)('%s does not report a rejected send', async (site) => {
  const client = clientFixture()
  client.sendRequest.mockResolvedValue({
    id: 'rpc',
    ok: true,
    result: { send: { accepted: false } }
  })
  const sites = mountSendSites(client)
  await act(async () => {
    await sites[site]()
  })
  expect(client.sendRequest.mock.calls.filter(([method]) => method === REPORT)).toHaveLength(0)
})
