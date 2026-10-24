// @vitest-environment happy-dom
import { createElement, useRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMobileSessionTerminalSendActions } from './use-mobile-session-terminal-send-actions'
import { useBufferedTerminalDrafts } from '../terminal/use-buffered-terminal-drafts'
import { RpcClientRequestTracker } from '../transport/rpc-client-request-tracker'
import type { MobileSessionTerminalWebviewModel } from './use-mobile-session-terminal-webview'

vi.mock('react-native', () => ({
  Keyboard: { dismiss: vi.fn(), addListener: () => ({ remove: vi.fn() }) }
}))
vi.mock('../platform/haptics', () => ({ triggerError: vi.fn(), triggerMediumImpact: vi.fn() }))
vi.mock('../terminal/worker-terminal-takeover-report', () => ({
  reportWorkerTerminalUserInput: vi.fn()
}))
vi.mock('../platform/host-os', () => ({ hostOs: () => 'android' }))

// The page's own sibling, because the listener this test dispatches to only exists there.
vi.mock(
  '../terminal/terminal-text-field-submit-binding',
  async () => await import('../terminal/terminal-text-field-submit-binding.web')
)

type Session = {
  readonly client: unknown
  readonly activeHandle: string | null
  readonly canSend: boolean
  readonly draft: string
}

const READY: Session = {
  client: { getState: () => 'connected' },
  activeHandle: 'terminal-a',
  canSend: true,
  draft: 'ls -la'
}

let restoredDrafts: string[] = []

function buildScope(session: Session): MobileSessionTerminalWebviewModel {
  const noop = (): void => {}
  const scope = {
    client: session.client,
    activeHandle: session.activeHandle,
    activeSessionTab: null,
    setActionTarget: noop,
    setMarkdownActionTarget: noop,
    setFileActionTarget: noop,
    setBrowserActionTarget: noop,
    setAgentSessionActionTarget: noop,
    keyboardHeight: 0,
    deviceTokenRef: { current: null },
    clientRef: { current: session.client },
    connStateRef: { current: 'connected' },
    liveInputRef: { current: null },
    commandInputRef: { current: null },
    liveInputFocusTimerRef: { current: null },
    sendLiveTerminalInputRef: { current: async () => true },
    sessionTabActionSheetKeyboardHideSubRef: { current: null },
    sessionTabActionSheetRequestSeqRef: { current: 0 },
    activeHandleRef: { current: session.activeHandle },
    activeSessionTabTypeRef: { current: 'terminal' },
    sendingRef: { current: false },
    bufferedTerminalDraftState: {
      input: session.draft,
      beginBufferedTerminalDraftSend: (handle: string, draft: string) => ({
        draft,
        handle,
        token: { handle }
      }),
      restoreRejectedDraft: (send: { draft: string }) => restoredDrafts.push(send.draft),
      settleBufferedTerminalDraftSend: () => true
    },
    getSendCompletionGeneration: () => completionGeneration,
    getLiveInteractionGeneration: () => 0,
    handleLiveInputAccessoryBytes: async () => ({ kind: 'allow-raw' }),
    handleLiveInputSubmit: async () => true,
    canSend: session.canSend,
    scheduleDelayedAction: noop,
    showToast: noop
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook destructures exactly the keys above, which the census beside this file pins; nothing else on the model is reachable from the submit path under test.
  return scope as unknown as MobileSessionTerminalWebviewModel
}

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} }
}))
vi.mock('../storage/mirrored-storage-keys', () => ({ persistMirrored: async () => {} }))

const frames: Array<{ id: string; method: string; params?: unknown }> = []
let tracker: RpcClientRequestTracker
let beforeConnect = async () => {}
let completionGeneration = 0
let actions: ReturnType<typeof useMobileSessionTerminalSendActions>
let drafts: ReturnType<typeof useBufferedTerminalDrafts>
let tree: ReactTestRenderer | null = null
function Probe({
  handle = 'terminal-a',
  owner = 'desktop:workspace'
}: {
  handle?: string
  owner?: string
}) {
  const handleRef = useRef<string | null>(handle)
  handleRef.current = handle
  drafts = useBufferedTerminalDrafts({
    activeHandle: handle,
    activeHandleRef: handleRef,
    storageScope: owner
  })
  const client = useRef({
    sendRequest: (...args: Parameters<RpcClientRequestTracker['sendRequest']>) =>
      tracker.sendRequest(...args)
  }).current
  const scope = buildScope({
    ...READY,
    activeHandle: handle,
    client
  })
  const refs = useRef(scope).current
  refs.activeHandleRef.current = handle
  actions = useMobileSessionTerminalSendActions({
    ...scope,
    sendingRef: refs.sendingRef,
    activeHandleRef: refs.activeHandleRef,
    bufferedTerminalDraftState: drafts
  })
  return null
}
async function mount() {
  frames.length = 0
  completionGeneration = 0
  beforeConnect = async () => {}
  tracker = new RpcClientRequestTracker({
    nextId: () => String(frames.length + 1),
    getState: () => 'connected',
    waitForConnected: () => beforeConnect(),
    sendFrame: (frame) => {
      frames.push(frame)
      return true
    }
  })
  await act(async () => {
    tree = create(createElement(Probe))
  })
  await act(async () => drafts.setInput('printf sent >> log'))
}
async function startSend() {
  let pending: Promise<void> | undefined
  await act(async () => {
    pending = actions.handleSend()
  })
  return async (result?: unknown) =>
    act(async () => {
      if (result !== undefined) {
        tracker.resolve({ id: frames.at(-1)!.id, ok: true, result })
      } else {
        tracker.rejectAll('Lost acknowledgment', { deliveryUnknown: true })
      }
      await pending
    })
}
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  tracker?.rejectAll('cleanup')
  vi.useRealTimers()
})
describe('buffered command recovery', () => {
  it('retains an ambiguous command outside the composer and blocks silent Send and Enter retries', async () => {
    await mount()
    const finish = await startSend()
    await finish()
    expect(drafts.input).toBe('')
    expect(drafts.unconfirmedCommand).toBe('printf sent >> log')
    expect(drafts.awaitingCommandConfirmation).toBe(false)
    await act(async () => {
      await actions.handleSend()
      await actions.handleSend()
    })
    expect(frames).toHaveLength(1)
    await act(async () => drafts.editUnconfirmedSend())
    expect(drafts.input).toBe('printf sent >> log')
    expect(drafts.unconfirmedCommand).toBeNull()
    const retry = await startSend()
    await retry({ send: { accepted: true } })
    expect(frames).toHaveLength(2)
    expect(drafts.input).toBe('')
    expect(drafts.unconfirmedCommand).toBeNull()
  })
  it('restores a definite host refusal normally', async () => {
    await mount()
    const finish = await startSend()
    await finish({ send: { accepted: false, bytesWritten: 0 } })
    expect(drafts.input).toBe('printf sent >> log')
    expect(drafts.unconfirmedCommand).toBeNull()
  })
  it('restores a definitely unsent command', async () => {
    await mount()
    beforeConnect = async () => {
      throw new Error('Not connected')
    }
    await act(async () => actions.handleSend())
    expect(frames).toHaveLength(0)
    expect(drafts.input).toBe('printf sent >> log')
    expect(drafts.unconfirmedCommand).toBeNull()
  })
  it('keeps newer typing and refuses to overwrite it during recovery', async () => {
    await mount()
    const finish = await startSend()
    await act(async () => drafts.setInput('new command'))
    await finish()
    await act(async () => drafts.editUnconfirmedSend())
    expect(drafts.input).toBe('new command')
    expect(drafts.unconfirmedCommand).toBe('printf sent >> log')
    await act(async () => actions.handleSend())
    expect(frames).toHaveLength(1)
    await act(async () => drafts.dismissUnconfirmedSend())
    expect(drafts.input).toBe('new command')
    expect(drafts.unconfirmedCommand).toBeNull()
  })
  it('retains a timed-out command without a replay', async () => {
    await mount()
    vi.useFakeTimers()
    const finish = await startSend()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000)
    })
    expect(drafts.input).toBe('')
    expect(drafts.unconfirmedCommand).toBe('printf sent >> log')
    await act(async () => actions.handleSend())
    expect(frames).toHaveLength(1)
    await finish()
  })
  it.each([{}, { send: { accepted: false, writeSettlement: { outcome: 'unknown' } } }])(
    'retains unverifiable reply %j',
    async (result) => {
      await mount()
      const finish = await startSend()
      await finish(result)
      expect(drafts.input).toBe('')
      expect(drafts.unconfirmedCommand).toBe('printf sent >> log')
      expect(frames[0].params).toMatchObject({ requireWriteSettlement: true })
    }
  )
  it('pins recovery to its terminal and rejects a stale handler after switching', async () => {
    await mount()
    const finish = await startSend()
    await finish()
    const staleEdit = drafts.editUnconfirmedSend
    const staleDismiss = drafts.dismissUnconfirmedSend
    await act(async () => tree?.update(createElement(Probe, { handle: 'terminal-b' })))
    await act(async () => {
      staleEdit()
      staleDismiss()
    })
    expect(drafts.input).toBe('')
    expect(drafts.unconfirmedCommand).toBeNull()
    await act(async () => tree?.update(createElement(Probe, { handle: 'terminal-a' })))
    expect(drafts.unconfirmedCommand).toBe('printf sent >> log')
  })
  it('does not publish an old owner completion into another desktop with the same terminal id', async () => {
    await mount()
    const finish = await startSend()
    await act(async () => tree?.update(createElement(Probe, { owner: 'other-desktop:workspace' })))
    await act(async () => drafts.setInput('other computer draft'))
    await finish()
    expect(drafts.input).toBe('other computer draft')
    expect(drafts.unconfirmedCommand).toBeNull()
  })
  it('admits one send before rendering and keeps the recovery barrier synchronous', async () => {
    await mount()
    const staleSend = actions.handleSend
    let pending: Promise<void> | undefined
    await act(async () => {
      pending = staleSend()
      void staleSend()
    })
    expect(frames).toHaveLength(1)
    await act(async () => {
      tracker.rejectAll('Lost reply', { deliveryUnknown: true })
      await pending
      await staleSend()
    })
    expect(frames).toHaveLength(1)
  })
})

it('refuses an old recovery callback when newer text was typed on the same terminal', async () => {
  await mount()
  const finish = await startSend()
  await finish()
  const staleEdit = drafts.editUnconfirmedSend
  await act(async () => drafts.setInput('keep this newer draft'))
  await act(async () => staleEdit())
  expect(drafts.input).toBe('keep this newer draft')
  expect(drafts.unconfirmedCommand).toBe('printf sent >> log')
})

it('cancels before dispatch when the route blurs while the recovery journal is preparing', async () => {
  await mount()
  let pending: Promise<void> | undefined
  await act(async () => {
    pending = actions.handleSend()
    completionGeneration += 1
    await pending
  })
  expect(frames).toHaveLength(0)
  expect(drafts.input).toBe('printf sent >> log')
  expect(drafts.unconfirmedCommand).toBeNull()
})
