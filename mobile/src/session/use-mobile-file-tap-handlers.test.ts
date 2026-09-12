import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMobileFileTapHandlers } from './use-mobile-file-tap-handlers'

const push = vi.fn()

vi.mock('expo-router', () => ({ useRouter: () => ({ push }) }))
vi.mock('../platform/haptics', () => ({ triggerSelection: vi.fn() }))

type Handlers = ReturnType<typeof useMobileFileTapHandlers>

function ok(result: unknown) {
  return { ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

describe('useMobileFileTapHandlers', () => {
  let renderer: ReactTestRenderer | null = null
  let handlers: Handlers | null = null

  beforeEach(() => {
    push.mockClear()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    handlers = null
  })

  function createOptions(sendRequest: ReturnType<typeof vi.fn>) {
    return {
      client: { sendRequest },
      hostId: 'host-1',
      worktreeId: 'wt-1',
      worktreeName: 'Orca',
      nativeChatSessionId: 'session-1',
      activeHandleRef: { current: 'terminal-1' as string | null },
      terminalCwdRef: { current: new Map([['terminal-1', '/repo/sub']]) },
      openBrowser: vi.fn(),
      fetchSessionTabs: vi.fn(async () => {}),
      getSessionTabs: () => [],
      getActiveSessionTabId: () => 'terminal-tab',
      getActiveSessionTabType: () => 'terminal',
      switchSessionTab: vi.fn(),
      scheduleDelayedAction: vi.fn(),
      reportChatTapFailure: vi.fn()
    }
  }

  function Harness({ options }: { options: ReturnType<typeof createOptions> }): null {
    handlers = useMobileFileTapHandlers(options)
    return null
  }

  it('keeps handler identities stable across rerenders', () => {
    const options = createOptions(vi.fn())
    act(() => {
      renderer = create(createElement(Harness, { options }))
    })
    const first = handlers
    act(() => {
      renderer!.update(createElement(Harness, { options: { ...options } }))
    })
    expect(handlers!.handleFileTap).toBe(first!.handleFileTap)
    expect(handlers!.handleNativeChatFileTap).toBe(first!.handleNativeChatFileTap)
  })

  it('dispatches through the latest options after a rerender', () => {
    const firstSendRequest = vi.fn()
    const firstOptions = createOptions(firstSendRequest)
    act(() => {
      renderer = create(createElement(Harness, { options: firstOptions }))
    })

    const latestSendRequest = vi.fn(async () => ok({ exists: false, isDirectory: false }))
    act(() => {
      renderer!.update(
        createElement(Harness, {
          options: { ...firstOptions, client: { sendRequest: latestSendRequest } }
        })
      )
    })
    handlers!.handleFileTap('terminal-1', 'index.ts', null, null)

    expect(firstSendRequest).not.toHaveBeenCalled()
    expect(latestSendRequest).toHaveBeenCalledTimes(1)
  })

  it('resolves terminal taps with the terminal handle and cwd', async () => {
    const sendRequest = vi.fn(async () => ok({ exists: false, isDirectory: false }))
    act(() => {
      renderer = create(createElement(Harness, { options: createOptions(sendRequest) }))
    })

    handlers!.handleFileTap('terminal-1', 'index.ts', null, null)
    await act(async () => {})

    expect(sendRequest).toHaveBeenCalledWith(
      'files.resolveTerminalPath',
      {
        worktree: 'id:wt-1',
        pathText: 'index.ts',
        terminal: 'terminal-1',
        cwd: '/repo/sub',
        crossWorkspace: true
      },
      { timeoutMs: 10_000 }
    )
  })

  it('ignores terminal taps from a non-active handle', () => {
    const sendRequest = vi.fn()
    act(() => {
      renderer = create(createElement(Harness, { options: createOptions(sendRequest) }))
    })

    handlers!.handleFileTap('terminal-2', 'index.ts', null, null)

    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('resolves chat taps against the worktree root and reports a miss', async () => {
    const sendRequest = vi.fn(async () => ok({ exists: false, isDirectory: false }))
    const options = createOptions(sendRequest)
    act(() => {
      renderer = create(createElement(Harness, { options }))
    })

    handlers!.handleNativeChatFileTap('mobile/src/x.ts:12')
    await act(async () => {})

    expect(sendRequest).toHaveBeenCalledWith(
      'files.resolveTerminalPath',
      {
        worktree: 'id:wt-1',
        pathText: 'mobile/src/x.ts',
        crossWorkspace: true,
        nativeChatContext: { tabId: 'terminal-tab', sessionId: 'session-1' }
      },
      { timeoutMs: 10_000 }
    )
    expect(options.reportChatTapFailure).toHaveBeenCalledWith("Couldn't open mobile/src/x.ts:12")
  })

  it('lets structured chat file taps resolve without a backing terminal handle', async () => {
    const sendRequest = vi.fn(async () => ok({ exists: false, isDirectory: false }))
    const options = {
      ...createOptions(sendRequest),
      activeHandleRef: { current: null as string | null },
      getActiveSessionTabId: () => 'agent-tab-1',
      getActiveSessionTabType: () => 'agent-session'
    }
    act(() => {
      renderer = create(createElement(Harness, { options }))
    })

    handlers!.handleNativeChatFileTap('src/app.ts')
    await act(async () => {})

    expect(sendRequest).toHaveBeenCalledWith(
      'files.resolveTerminalPath',
      {
        worktree: 'id:wt-1',
        pathText: 'src/app.ts',
        crossWorkspace: true,
        nativeChatContext: { tabId: 'agent-tab-1', sessionId: 'session-1' }
      },
      { timeoutMs: 10_000 }
    )
  })
})
