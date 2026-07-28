import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../src/shared/types'
import type { RpcClient } from '../transport/rpc-client'
import type { ReviewScreenState } from './mobile-diff-review-screen-model'
import {
  isMobileNativeChatInputStale,
  markMobileNativeChatInputStale,
  resetMobileNativeChatStaleInputForTests
} from './mobile-native-chat-stale-input'
import { useMobileDiffReviewSendActions } from './use-mobile-diff-review-send-actions'

type SendActions = ReturnType<typeof useMobileDiffReviewSendActions>

vi.mock('../platform/haptics', () => ({ triggerSuccess: vi.fn() }))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn().mockResolvedValue(undefined) }))

function sendResponse(accepted: boolean) {
  return {
    id: 'send',
    ok: true as const,
    result: { send: { accepted } },
    _meta: { runtimeId: 'runtime' }
  }
}

const COMMENT: DiffComment = {
  id: 'comment-1',
  worktreeId: 'wt-1',
  filePath: 'src/a.ts',
  lineNumber: 3,
  body: 'rename this',
  createdAt: 1,
  side: 'modified'
}

const READY: ReviewScreenState = {
  kind: 'ready',
  status: { entries: [], conflictOperation: 'none' },
  branchCompare: null,
  comments: [COMMENT],
  reviewState: { version: 1, files: {} }
}

describe('useMobileDiffReviewSendActions', () => {
  let renderer: ReactTestRenderer | null = null
  let actions: SendActions | null = null
  let mountedClient: RpcClient | null = null
  let setActionError: ReturnType<typeof vi.fn>
  let setSendSheet: ReturnType<typeof vi.fn>
  let saveCommentsAndReviewState: ReturnType<typeof vi.fn>

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    resetMobileNativeChatStaleInputForTests()
    setActionError = vi.fn()
    setSendSheet = vi.fn()
    saveCommentsAndReviewState = vi.fn().mockResolvedValue(undefined)
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    actions = null
    mountedClient = null
  })

  function Harness(): null {
    actions = useMobileDiffReviewSendActions({
      client: mountedClient,
      connState: 'connected',
      worktreeId: 'wt-1',
      screenState: READY,
      setActionError,
      setSendSheet,
      saveCommentsAndReviewState
    })
    return null
  }

  async function mount(client: RpcClient): Promise<void> {
    mountedClient = client
    const original = console.error
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...args)
    })
    try {
      await act(async () => {
        renderer = create(createElement(Harness))
      })
    } finally {
      consoleSpy.mockRestore()
    }
  }

  it('heals a marked terminal BEFORE submitting the notes', async () => {
    const sendRequest = vi.fn().mockResolvedValue(sendResponse(true))
    await mount({ sendRequest } as unknown as RpcClient)
    markMobileNativeChatInputStale('terminal-1')

    await act(async () => {
      await actions?.sendPromptToTerminal('terminal-1', [COMMENT])
    })

    expect(sendRequest).toHaveBeenCalledTimes(2)
    // Order matters: the Ctrl+U clear must land before the enter-carrying write,
    // or the orphaned paste is submitted with the notes.
    expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({
      terminal: 'terminal-1',
      text: '\x15',
      enter: false
    })
    expect(sendRequest.mock.calls[1]?.[1]).toMatchObject({ terminal: 'terminal-1', enter: true })
    // The second call is the notes themselves, not another clear.
    expect(String(sendRequest.mock.calls[1]?.[1]?.text)).toContain('rename this')
    expect(isMobileNativeChatInputStale('terminal-1')).toBe(false)
    expect(setActionError).toHaveBeenCalledWith('Review notes sent')
  })

  it('does not submit when the heal reports the line is not safe', async () => {
    const sendRequest = vi.fn().mockResolvedValue(sendResponse(false))
    await mount({ sendRequest } as unknown as RpcClient)
    markMobileNativeChatInputStale('terminal-1')

    let error: unknown
    await act(async () => {
      error = await actions?.sendPromptToTerminal('terminal-1', [COMMENT]).catch((err) => err)
    })

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Failed to send notes')
    // Only the failed clear — never the notes.
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({ text: '\x15', enter: false })
    expect(saveCommentsAndReviewState).not.toHaveBeenCalled()
    expect(setActionError).not.toHaveBeenCalled()
    expect(setSendSheet).not.toHaveBeenCalled()
    // Marker survives for the next attempt.
    expect(isMobileNativeChatInputStale('terminal-1')).toBe(true)
  })

  it('keeps the marker and skips the notes when the clear throws', async () => {
    const sendRequest = vi.fn().mockRejectedValue(new Error('offline'))
    await mount({ sendRequest } as unknown as RpcClient)
    markMobileNativeChatInputStale('terminal-1')

    let error: unknown
    await act(async () => {
      error = await actions?.sendPromptToTerminal('terminal-1', [COMMENT]).catch((err) => err)
    })

    expect((error as Error).message).toBe('Failed to send notes')
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(saveCommentsAndReviewState).not.toHaveBeenCalled()
    expect(isMobileNativeChatInputStale('terminal-1')).toBe(true)
  })

  it('sends an unmarked terminal with no extra RPC', async () => {
    const sendRequest = vi.fn().mockResolvedValue(sendResponse(true))
    await mount({ sendRequest } as unknown as RpcClient)

    await act(async () => {
      await actions?.sendPromptToTerminal('terminal-1', [COMMENT])
    })

    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest.mock.calls[0]?.[0]).toBe('terminal.send')
    expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({ terminal: 'terminal-1', enter: true })
    expect(saveCommentsAndReviewState).toHaveBeenCalledTimes(1)
    expect(setActionError).toHaveBeenCalledWith('Review notes sent')
    expect(setSendSheet).toHaveBeenCalledWith(null)
  })

  it('only heals the terminal that was marked', async () => {
    const sendRequest = vi.fn().mockResolvedValue(sendResponse(true))
    await mount({ sendRequest } as unknown as RpcClient)
    markMobileNativeChatInputStale('terminal-other')

    await act(async () => {
      await actions?.sendPromptToTerminal('terminal-1', [COMMENT])
    })

    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(isMobileNativeChatInputStale('terminal-other')).toBe(true)
  })

  it('still reports a rejected terminal.send after a successful heal', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(sendResponse(true))
      .mockResolvedValueOnce(sendResponse(false))
    await mount({ sendRequest } as unknown as RpcClient)
    markMobileNativeChatInputStale('terminal-1')

    let error: unknown
    await act(async () => {
      error = await actions?.sendPromptToTerminal('terminal-1', [COMMENT]).catch((err) => err)
    })

    expect((error as Error).message).toBe('Terminal input is locked')
    expect(saveCommentsAndReviewState).not.toHaveBeenCalled()
  })

  it('reports a failed terminal.send response', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValue({ id: 'send', ok: false, error: { message: 'pane gone' } })
    await mount({ sendRequest } as unknown as RpcClient)

    let error: unknown
    await act(async () => {
      error = await actions?.sendPromptToTerminal('terminal-1', [COMMENT]).catch((err) => err)
    })

    expect((error as Error).message).toBe('pane gone')
    expect(saveCommentsAndReviewState).not.toHaveBeenCalled()
  })
})
