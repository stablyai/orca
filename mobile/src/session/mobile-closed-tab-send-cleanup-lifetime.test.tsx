import { createElement, useRef, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import { useMobileSessionCloseActions } from './use-mobile-session-close-actions'
import { useMobileNativeChatFileAttachments } from './native-chat/composer/use-mobile-native-chat-file-attachments'
import { useMobileNativeChatImageAttachments } from './native-chat/composer/use-mobile-native-chat-image-attachments'
import {
  pruneMobileNativeChatTabInputs,
  readMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs
} from './native-chat/composer/mobile-native-chat-draft-inputs'
import { resetMobileNativeChatDraftStoreForTests } from './native-chat/composer/mobile-native-chat-draft-store'
import { resetMobileNativeChatStaleInputForTests } from './native-chat/mobile-native-chat-stale-input'
import { resetMobileNativeChatTerminalWritesForTests } from './native-chat/mobile-native-chat-terminal-write-lock'
import type { MobileNativeChatSendOutcome } from './native-chat/mobile-native-chat-send'

vi.mock('../platform/media-picker', () => ({
  useMediaPicker: () => ({ pickImages: async () => [], pickFiles: async function* () {} })
}))

const ORIGINAL = 'host\0folder:workspace\0original'
const OTHER = 'host\0folder:workspace\0other'
let renderer: ReactTestRenderer | undefined

afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined
  resetMobileNativeChatDraftStoreForTests()
  resetMobileNativeChatStaleInputForTests()
  resetMobileNativeChatTerminalWritesForTests()
})

function appendStoredInputs(scope: string, id: string, structured: boolean): void {
  updateMobileNativeChatDraftInputs(scope, (current) => ({
    ...current,
    images: [...current.images, { id, path: `/${id}.png`, previewUri: `file:///${id}.png` }],
    files: structured
      ? [
          ...current.files,
          { id, path: `/${id}.txt`, name: `${id}.txt`, mime: 'text/plain', byteLength: 1 }
        ]
      : current.files
  }))
}

async function mount(structured: boolean) {
  let deliver: (outcome: MobileNativeChatSendOutcome) => void = () => {}
  const delivery = new Promise<MobileNativeChatSendOutcome>((resolve) => {
    deliver = resolve
  })
  let started: () => void = () => {}
  const opened = new Promise<void>((resolve) => {
    started = resolve
  })
  const baseSend = vi.fn<Parameters<typeof useMobileNativeChatImageAttachments>[0]['baseSend']>(
    async () => {
      started()
      return delivery
    }
  )
  const client = stubRpcClient({
    sendRequest: async (method) =>
      method === 'terminal.send'
        ? { id: 'send', ok: true, result: { send: { accepted: true } } }
        : { id: 'close', ok: true, result: { closed: true, retirementConfirmed: true } }
  })
  let current:
    | {
        send: (text: string) => Promise<boolean>
        close: () => Promise<void>
        navigate: () => void
      }
    | undefined
  function Harness(): null {
    const [tab, setTab] = useState<string | null>('original')
    const activeHandleRef = useRef<string | null>('term-original')
    const activeTabRef = useRef<string | null>('original')
    const selectedTabRef = useRef<string | null>('original')
    const key = tab ? `host\0folder:workspace\0${tab}` : null
    const files = useMobileNativeChatFileAttachments({
      client,
      sessionId: 'session',
      scopeKey: key,
      enabled: structured,
      showToast: vi.fn()
    })
    const images = useMobileNativeChatImageAttachments({
      client,
      scopeKey: key,
      agent: 'claude',
      activeHandleRef,
      deviceTokenRef: { current: null },
      getActiveWorktreeConnectionId: async () => null,
      connState: 'connected',
      enabled: true,
      structuredNativeChat: structured,
      files: files.files,
      onFilesSent: files.removeFiles,
      showToast: vi.fn(),
      onSendError: vi.fn(),
      baseSend,
      readSeededLaunchDraft: () => null,
      sleep: async () => {}
    })
    const closeScope = {
      hostId: 'host',
      worktreeId: 'folder:workspace',
      client,
      setSessionTabs: vi.fn(),
      setFileDocs: vi.fn(),
      setMarkdownDocs: vi.fn(),
      sessionTabsRef: { current: [] },
      reconcileBufferedDraftsRef: { current: vi.fn() },
      closedTabTombstonesRef: { current: new Map() },
      clearTerminalLiveInputDefault: vi.fn(),
      setActiveHandle: vi.fn(),
      setActiveSessionTabId: setTab,
      activeSessionTabIdRef: activeTabRef,
      selectedSessionTabIdRef: selectedTabRef,
      renameTarget: null,
      setRenameTarget: vi.fn(),
      terminalRefs: { current: new Map() },
      activeHandleRef,
      activeSessionTabTypeRef: { current: 'terminal' },
      pendingSelectionRef: { current: null },
      pendingBrowserFocusPageIdRef: { current: null },
      scheduleDelayedAction: vi.fn(),
      unsubscribeTerminal: vi.fn(),
      subscribeToTerminal: vi.fn(),
      fetchTerminals: vi.fn()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness supplies every field used by confirmed tab close; unrelated route actions are unused.
    const close = useMobileSessionCloseActions(closeScope as never)
    current = {
      send: images.sendNativeChat,
      close: () =>
        close.handleCloseSessionTab({
          type: 'terminal',
          id: 'original',
          title: 'Original',
          terminal: 'term-original',
          isActive: true
        }),
      navigate: () => {
        activeHandleRef.current = 'term-other'
        activeTabRef.current = 'other'
        selectedTabRef.current = 'other'
        setTab('other')
      }
    }
    return null
  }
  await act(async () => {
    renderer = create(createElement(Harness))
  })
  await act(async () => appendStoredInputs(ORIGINAL, 'sent', structured))
  const read = () => {
    if (!current) {
      throw new Error('send cleanup hooks did not mount')
    }
    return current
  }
  return {
    read,
    baseSend,
    async begin() {
      let sending: Promise<boolean> | undefined
      await act(async () => {
        sending = read().send('draft')
        await opened
      })
      return {
        async finish(outcome: MobileNativeChatSendOutcome) {
          let accepted: boolean | undefined
          await act(async () => {
            deliver(outcome)
            accepted = await sending
          })
          return accepted
        }
      }
    }
  }
}

it.each([
  [false, 'accepted'],
  [false, 'unknown'],
  [true, 'accepted'],
  [true, 'unknown']
] as const)(
  'keeps closed input and destination records retired: structured=%s, outcome=%s',
  async (structured, outcome) => {
    const screen = await mount(structured)
    const send = await screen.begin()
    expect(screen.baseSend).toHaveBeenCalledTimes(1)
    await act(async () => screen.read().close())
    const retired = readMobileNativeChatDraftInputs(ORIGINAL)
    expect(retired.images).toHaveLength(0)
    expect(retired.files).toHaveLength(0)
    expect(pruneMobileNativeChatTabInputs('host', 'folder:workspace', [])).toEqual([])
    expect(await send.finish(outcome)).toBe(true)
    expect(readMobileNativeChatDraftInputs(ORIGINAL)).toBe(retired)
    expect(pruneMobileNativeChatTabInputs('host', 'folder:workspace', [])).toEqual([])
  }
)

it.each([
  [false, 'accepted'],
  [false, 'unknown'],
  [true, 'accepted'],
  [true, 'unknown']
] as const)(
  'clears only the sent inputs on the original live tab after navigation: structured=%s, outcome=%s',
  async (structured, outcome) => {
    const screen = await mount(structured)
    const send = await screen.begin()
    await act(async () => {
      appendStoredInputs(ORIGINAL, 'newer', structured)
      screen.read().navigate()
      appendStoredInputs(OTHER, 'other', structured)
    })
    expect(await send.finish(outcome)).toBe(true)
    expect(readMobileNativeChatDraftInputs(ORIGINAL).images.map((image) => image.id)).toEqual([
      'newer'
    ])
    expect(readMobileNativeChatDraftInputs(ORIGINAL).files.map((file) => file.id)).toEqual(
      structured ? ['newer'] : []
    )
    expect(readMobileNativeChatDraftInputs(OTHER).images.map((image) => image.id)).toEqual([
      'other'
    ])
    expect(readMobileNativeChatDraftInputs(OTHER).files.map((file) => file.id)).toEqual(
      structured ? ['other'] : []
    )
  }
)
