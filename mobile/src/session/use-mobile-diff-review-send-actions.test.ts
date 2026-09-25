import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { ReviewScreenState } from './mobile-diff-review-screen-model'
import {
  isMobileNativeChatInputStale,
  markMobileNativeChatInputStale,
  resetMobileNativeChatStaleInputForTests
} from './mobile-native-chat-stale-input'
import { useMobileDiffReviewSendActions } from './use-mobile-diff-review-send-actions'

// A connected client whose only behaviour is the scripted `sendRequest`.
function requestPortRpcClient(sendRequest: RpcClient['sendRequest']): RpcClient {
  return {
    sendRequest,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
}

type SendActions = ReturnType<typeof useMobileDiffReviewSendActions>

vi.mock('../platform/haptics', () => ({ triggerSuccess: vi.fn() }))
// Resolving `true`, which is what the pasteboard answers when it took the text: the seam reads
// that boolean, and a mock resolving `undefined` put every copy down the refusal arm unseen.
const clipboardMock = vi.hoisted(() => ({ setStringAsync: vi.fn() }))
vi.mock('expo-clipboard', () => clipboardMock)

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

const LAUNCH_CAPABILITIES = [
  'agent.launch.v2',
  'agent.launch.replay.v1',
  'agent.launch.replay-required.v1'
]

function rpcReply(result: unknown) {
  return { id: 'rpc', ok: true as const, result, _meta: { runtimeId: 'r' } }
}

function launchedReply(promptOutcome: 'handed-to-terminal' | 'not-delivered') {
  return rpcReply({
    outcome: { kind: 'terminal', handle: 'term-1' },
    worktreeId: 'wt-1',
    receipt: { mode: 'terminal', preferred: 'terminal', reason: 'user_default', detail: 'd' },
    prompt: { delivery: 'submit', outcome: promptOutcome }
  })
}

// Answers the agent loader's reads and the launch, by method.
function launchClient(
  promptOutcome: 'handed-to-terminal' | 'not-delivered',
  launchReply: () => Promise<RpcResponse> = async () => launchedReply(promptOutcome)
) {
  const sendRequest = vi.fn(async (method: string, _params?: unknown): Promise<RpcResponse> => {
    if (method === 'repo.list') {
      return rpcReply({ repos: [{ id: 'wt-1' }] })
    }
    if (method === 'settings.get') {
      return rpcReply({ settings: { defaultTuiAgent: 'codex' } })
    }
    if (method === 'preflight.detectAgents') {
      return rpcReply(['codex'])
    }
    return launchReply()
  })
  return { client: requestPortRpcClient(sendRequest), sendRequest }
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
  let screenState: ReviewScreenState = READY

  beforeEach(() => {
    screenState = READY
    clipboardMock.setStringAsync.mockReset().mockResolvedValue(true)
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
      hostCapabilities: LAUNCH_CAPABILITIES,
      worktreeId: 'wt-1',
      screenState,
      setActionError,
      setSendSheet,
      saveCommentsAndReviewState
    })
    return null
  }

  async function mount(client: RpcClient): Promise<void> {
    mountedClient = client
    await act(async () => {
      renderer = create(createElement(Harness))
    })
  }

  /** Copying reaches no client, so the cases below mount without one rather than stubbing it. */
  async function mountWithoutClient(): Promise<void> {
    mountedClient = null
    await act(async () => {
      renderer = create(createElement(Harness))
    })
  }

  it('copies the notes through the platform seam and says so', async () => {
    await mountWithoutClient()
    await act(async () => {
      await actions?.copyNotes()
    })
    expect(clipboardMock.setStringAsync).toHaveBeenCalledOnce()
    expect(setActionError).toHaveBeenLastCalledWith('Review notes copied')
  })

  it('reports a refused copy instead of claiming it copied', async () => {
    // The pasteboard answering `false` is the case the seam exists to surface: on the web the verb
    // is refused when the route was not granted it, and the only caller is a floating promise.
    clipboardMock.setStringAsync.mockResolvedValue(false)
    await mountWithoutClient()
    await act(async () => {
      await actions?.copyNotes()
    })
    expect(setActionError).toHaveBeenLastCalledWith('the clipboard did not accept this text')
  })

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

  it('starts a new agent with the notes through the host and marks them sent', async () => {
    const { client, sendRequest } = launchClient('handed-to-terminal')
    await mount(client)
    await act(async () => {
      await actions?.createTerminalAndSend([COMMENT])
    })
    const launch = sendRequest.mock.calls.find(([method]) => method === 'agent.launchReplay')
    expect(launch?.[1]).toMatchObject({
      agent: 'codex',
      target: { kind: 'existing', worktree: 'id:wt-1' },
      prompt: { delivery: 'submit' },
      launchSource: 'notes_send'
    })
    expect(sendRequest.mock.calls.some(([method]) => method === 'terminal.send')).toBe(false)
    expect(saveCommentsAndReviewState).toHaveBeenCalledOnce()
    expect(setActionError).toHaveBeenLastCalledWith('Review notes sent')
  })

  it('keeps the notes unsent when the agent started without them', async () => {
    await mount(launchClient('not-delivered').client)
    await act(async () => {
      await actions?.createTerminalAndSend([COMMENT])
    })
    expect(saveCommentsAndReviewState).not.toHaveBeenCalled()
    expect(setActionError).toHaveBeenLastCalledWith(
      "The agent started, but the notes weren't sent. Use Copy Notes to paste them."
    )
  })

  it('shows a launch that did not start on the review screen instead of rejecting', async () => {
    await mount(
      launchClient('handed-to-terminal', async () => ({
        id: 'rpc',
        ok: false,
        error: { code: 'selector_not_found', message: 'Workspace not found' },
        _meta: { runtimeId: 'r' }
      })).client
    )
    await act(async () => {
      await actions?.createTerminalAndSend([COMMENT])
    })
    expect(setSendSheet).toHaveBeenCalledWith(null)
    expect(setActionError).toHaveBeenLastCalledWith('Workspace not found')
    expect(saveCommentsAndReviewState).not.toHaveBeenCalled()
  })

  it('starts one agent for a double tap and keeps notes written while it starts', async () => {
    let answerLaunch: (reply: RpcResponse) => void = () => {}
    const { client, sendRequest } = launchClient(
      'handed-to-terminal',
      () =>
        new Promise<RpcResponse>((resolve) => {
          answerLaunch = resolve
        })
    )
    await mount(client)
    let first: Promise<void> | undefined
    await act(async () => {
      first = actions?.createTerminalAndSend([COMMENT])
      await actions?.createTerminalAndSend([COMMENT])
    })
    expect(setActionError).toHaveBeenLastCalledWith('Starting an agent...')
    const written: DiffComment = { ...COMMENT, id: 'comment-2', body: 'written meanwhile' }
    screenState = { ...READY, comments: [COMMENT, written] }
    await act(async () => {
      renderer?.update(createElement(Harness))
    })
    await act(async () => {
      answerLaunch(launchedReply('handed-to-terminal'))
      await first
    })
    expect(
      sendRequest.mock.calls.filter(([method]) => method === 'agent.launchReplay')
    ).toHaveLength(1)
    expect(saveCommentsAndReviewState).toHaveBeenCalledWith(
      [
        expect.objectContaining({ id: 'comment-1', sentAt: expect.any(Number) }),
        expect.not.objectContaining({ sentAt: expect.anything() })
      ],
      READY.reviewState
    )
    expect(saveCommentsAndReviewState.mock.calls[0]?.[0]?.[1]?.id).toBe('comment-2')
    expect(setActionError).toHaveBeenLastCalledWith('Review notes sent')
  })
})
