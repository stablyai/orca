import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'
import type { UnvalidatedRpcRequestPort } from '../transport/unvalidated-rpc-request-port'
import { useMobileFileTapHandlers } from './use-mobile-file-tap-handlers'
import { useMobileSendCompletionGeneration } from './use-mobile-send-completion-generation'

const push = vi.fn()
const navigation = vi.hoisted(() => ({ focused: true }))
const onBlur = () => {}
const setRouteFocused = (focused: boolean) => {
  navigation.focused = focused
}

vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    useRouter: () => ({ push }),
    useFocusEffect(effect: () => void | (() => void)) {
      React.useEffect(
        () => (navigation.focused ? effect() : undefined),
        [effect, navigation.focused]
      )
    }
  }
})
vi.mock('../platform/haptics', () => ({ triggerSelection: vi.fn() }))

type Handlers = ReturnType<typeof useMobileFileTapHandlers>

function ok(result: unknown): RpcResponse {
  return { id: 'rpc', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

describe('useMobileFileTapHandlers', () => {
  let renderer: ReactTestRenderer | null = null
  let handlers: Handlers | null = null

  beforeEach(() => {
    push.mockClear()
    navigation.focused = true
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    handlers = null
  })

  function createOptions(sendRequest: UnvalidatedRpcRequestPort['sendRequest']) {
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
    const getSendCompletionGeneration = useMobileSendCompletionGeneration({
      onBlur,
      surfaceKey: JSON.stringify([
        options.hostId,
        options.worktreeId,
        options.activeHandleRef.current
      ])
    })
    handlers = useMobileFileTapHandlers({ ...options, getSendCompletionGeneration })
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
    handlers!.handleFileTap('terminal-1', [{ pathText: 'index.ts', line: null, column: null }])

    expect(firstSendRequest).not.toHaveBeenCalled()
    expect(latestSendRequest).toHaveBeenCalledTimes(1)
  })

  it('resolves terminal taps with the terminal handle and cwd', async () => {
    const sendRequest = vi.fn(async () => ok({ exists: false, isDirectory: false }))
    act(() => {
      renderer = create(createElement(Harness, { options: createOptions(sendRequest) }))
    })

    handlers!.handleFileTap('terminal-1', [{ pathText: 'index.ts', line: null, column: null }])
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

  it.each([
    [
      'host refusal',
      {
        id: 'rpc',
        ok: false,
        error: {
          code: 'runtime_error',
          message: "Files outside an SSH workspace can't be opened from another device yet."
        }
      },
      "Files outside an SSH workspace can't be opened from another device yet."
    ],
    [
      'old-host refusal',
      { id: 'rpc', ok: false, error: { code: 'runtime_error', message: '' } },
      "Couldn't open /tmp/report.md"
    ],
    ['unresolved miss', ok({ exists: false, isDirectory: false }), null],
    ['directory', ok({ exists: true, isDirectory: true }), null]
  ] as const)('reports only a real terminal %s', async (_name, response, expected) => {
    const options = createOptions(vi.fn(async () => response))
    act(() => {
      renderer = create(createElement(Harness, { options }))
    })
    handlers!.handleFileTap('terminal-1', [
      { pathText: '/tmp/report.md', line: null, column: null }
    ])
    await act(async () => {})
    expect(options.reportChatTapFailure.mock.calls).toEqual(expected === null ? [] : [[expected]])
  })

  it('opens a successful sibling reading despite another host refusal', async () => {
    const sendRequest = vi.fn<UnvalidatedRpcRequestPort['sendRequest']>(async (_method, params) => {
      if (
        typeof params === 'object' &&
        params !== null &&
        'pathText' in params &&
        params.pathText === '/tmp/report.md'
      ) {
        return {
          id: 'rpc',
          ok: false,
          error: { code: 'runtime_error', message: 'Outside SSH workspace' }
        }
      }
      return ok({
        exists: true,
        isDirectory: false,
        relativePath: 'report.md',
        openTarget: {
          kind: 'worktree-file',
          provider: 'ssh',
          relativePath: 'report.md',
          absolutePath: '/repo/report.md'
        }
      })
    })
    const options = createOptions(sendRequest)
    act(() => {
      renderer = create(createElement(Harness, { options }))
    })
    handlers!.handleFileTap('terminal-1', [
      { pathText: '/tmp/report.md', line: null, column: null },
      { pathText: 'report.md', line: 2, column: null }
    ])
    await act(async () => {})
    expect(push).toHaveBeenCalledOnce()
    expect(push.mock.calls[0][0].params.relativePath).toBe('report.md')
    expect(options.reportChatTapFailure).not.toHaveBeenCalled()
  })

  it.each([
    'tab switch',
    'tab round trip',
    'route round trip',
    'newer tap',
    'workspace change',
    'unmount'
  ] as const)('suppresses a late host refusal after %s', async (navigation) => {
    let refuse!: (response: RpcResponse) => void
    const sendRequest = vi
      .fn<UnvalidatedRpcRequestPort['sendRequest']>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            refuse = resolve
          })
      )
      .mockResolvedValue(ok({ exists: false, isDirectory: false }))
    const options = createOptions(sendRequest)
    act(() => {
      renderer = create(createElement(Harness, { options }))
    })
    handlers!.handleFileTap('terminal-1', [
      { pathText: '/tmp/report.md', line: null, column: null }
    ])
    if (navigation === 'tab switch') {
      options.activeHandleRef.current = 'terminal-2'
    }
    if (navigation === 'tab round trip') {
      options.activeHandleRef.current = 'terminal-2'
      act(() => {
        renderer!.update(createElement(Harness, { options }))
      })
      options.activeHandleRef.current = 'terminal-1'
      act(() => {
        renderer!.update(createElement(Harness, { options }))
      })
    }
    if (navigation === 'route round trip') {
      setRouteFocused(false)
      act(() => {
        renderer!.update(createElement(Harness, { options }))
      })
      setRouteFocused(true)
      act(() => {
        renderer!.update(createElement(Harness, { options }))
      })
    }
    if (navigation === 'newer tap') {
      handlers!.handleFileTap('terminal-1', [{ pathText: 'missing.ts', line: null, column: null }])
    }
    if (navigation === 'workspace change') {
      act(() => {
        renderer!.update(createElement(Harness, { options: { ...options, worktreeId: 'wt-2' } }))
      })
    }
    if (navigation === 'unmount') {
      act(() => {
        renderer!.unmount()
        renderer = null
      })
    }
    refuse({
      id: 'rpc',
      ok: false,
      error: { code: 'runtime_error', message: 'Outside SSH workspace' }
    })
    await act(async () => {})
    expect(options.reportChatTapFailure).not.toHaveBeenCalled()
  })

  it('ignores terminal taps from a non-active handle', () => {
    const sendRequest = vi.fn()
    act(() => {
      renderer = create(createElement(Harness, { options: createOptions(sendRequest) }))
    })

    handlers!.handleFileTap('terminal-2', [{ pathText: 'index.ts', line: null, column: null }])

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
