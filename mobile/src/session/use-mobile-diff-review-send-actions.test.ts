import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { ReviewScreenState } from './mobile-diff-review-screen-model'
import type { ReviewSheetIntents } from './mobile-diff-review-sheets'
import { resetMobileNativeChatStaleInputForTests } from './native-chat/mobile-native-chat-stale-input'
import { useMobileDiffReviewSendActions } from './use-mobile-diff-review-send-actions'

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
type SendActionArgs = Parameters<typeof useMobileDiffReviewSendActions>[0]

vi.mock('../platform/haptics', () => ({ triggerSuccess: vi.fn() }))
// Return the pasteboard’s real success boolean; undefined would exercise only refusal unnoticed.
const clipboardMock = vi.hoisted(() => ({ setStringAsync: vi.fn() }))
vi.mock('expo-clipboard', () => clipboardMock)

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

function launchedReply(promptOutcome: 'handed-to-terminal' | 'not-delivered', warning?: string) {
  return rpcReply({
    outcome: { kind: 'terminal', handle: 'term-1' },
    worktreeId: 'wt-1',
    receipt: { mode: 'terminal', preferred: 'terminal', reason: 'user_default', detail: 'd' },
    prompt: { delivery: 'submit', outcome: promptOutcome },
    ...(warning ? { warning } : {})
  })
}

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
    if (method === 'agent.launchReplay') {
      return launchReply()
    }
    throw new Error(`Unexpected request: ${method}`)
  })
  return { client: requestPortRpcClient(sendRequest), sendRequest }
}

const READY: Extract<ReviewScreenState, { kind: 'ready' }> = {
  kind: 'ready',
  status: {
    entries: [],
    conflictOperation: 'unknown',
    branch: undefined,
    head: undefined,
    upstreamStatus: undefined
  },
  branchCompare: null,
  comments: [COMMENT],
  reviewState: { version: 1, files: {} }
}

describe('useMobileDiffReviewSendActions', () => {
  let renderer: ReactTestRenderer | null = null
  let actions: SendActions | null = null
  let mountedClient: RpcClient | null = null
  let setActionError: Mock<SendActionArgs['setActionError']>
  let sheets: {
    openSheet: Mock<ReviewSheetIntents['openSheet']>
    openSheetWhenIdle: Mock<ReviewSheetIntents['openSheetWhenIdle']>
    closeSheet: Mock<ReviewSheetIntents['closeSheet']>
    updateSendSheet: Mock<ReviewSheetIntents['updateSendSheet']>
  }
  let saveCommentsAndReviewState: Mock<SendActionArgs['saveCommentsAndReviewState']>
  let screenState: ReviewScreenState = READY

  beforeEach(() => {
    screenState = READY
    clipboardMock.setStringAsync.mockReset().mockResolvedValue(true)
    resetMobileNativeChatStaleInputForTests()
    setActionError = vi.fn()
    sheets = {
      openSheet: vi.fn(),
      openSheetWhenIdle: vi.fn(),
      closeSheet: vi.fn(),
      updateSendSheet: vi.fn()
    }
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
      sheets,
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

  // The save rolls back to the screen it was created with, so a stale one would drop newer notes.
  it('marks the notes sent through the save of the latest render, not the one from the tap', async () => {
    let answerLaunch: (reply: RpcResponse) => void = () => {}
    const { client } = launchClient(
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
    })
    const tapTimeSave = saveCommentsAndReviewState
    saveCommentsAndReviewState = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      renderer?.update(createElement(Harness))
    })
    await act(async () => {
      answerLaunch(launchedReply('handed-to-terminal'))
      await first
    })
    expect(tapTimeSave).not.toHaveBeenCalled()
    expect(saveCommentsAndReviewState).toHaveBeenCalledOnce()
  })
})
