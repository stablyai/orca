import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'
import type { UnvalidatedRpcRequestPort } from '../transport/unvalidated-rpc-request-port'
import { useMobileFileTapHandlers } from './use-mobile-file-tap-handlers'
import { parseMobileMarkdownTree } from '../components/mobile-markdown-tree'
import { routeMarkdownHref } from '../components/markdown-href-routing'
import { WorkspaceExecutionHostContext } from '../navigation/workspace-execution-host'
import type { ExecutionHostId } from '../../../src/shared/execution-host'

const push = vi.fn()
const navigate = vi.fn()
const lifecycle = vi.hoisted(() => ({ focused: true }))

vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    useRouter: () => ({ push, navigate }),
    useFocusEffect(effect: () => void | (() => void)): void {
      React.useEffect(() => (lifecycle.focused ? effect() : undefined), [effect, lifecycle.focused])
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
    navigate.mockClear()
    lifecycle.focused = true
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
    handlers = useMobileFileTapHandlers(options)
    return null
  }

  it.each<{ executionHost: ExecutionHostId | undefined; folder: boolean }>([
    { executionHost: undefined, folder: false },
    { executionHost: 'runtime:server-1', folder: false },
    { executionHost: 'ssh:server-1', folder: false },
    { executionHost: 'runtime:server-1', folder: true }
  ])(
    'opens the handoff workspace link on $executionHost (folder=$folder)',
    async ({ executionHost, folder }) => {
      const targetPath =
        '/Users/jinjingliang/Documents/projects/orca/improve-plugin-category-display'
      const targetId = folder
        ? 'folder:target'
        : `48e366bb-2436-46a9-bb37-10ace25ada5f::${targetPath}`
      const markdown =
        'Handed off via orca-cli to **gpt-6.1-sol, high effort** in the [Orca worktree](/Users/jinjingliang/Documents/projects/orca/improve-plugin-category-display).'
      const paragraph = parseMobileMarkdownTree(markdown, false).children[0]
      const link =
        paragraph?.type === 'paragraph'
          ? paragraph.children.find((node) => node.type === 'link')
          : undefined
      if (link?.type !== 'link') {
        throw new Error('Handoff link did not parse')
      }
      const route = routeMarkdownHref(link.url)
      if (route.kind !== 'file') {
        throw new Error('Handoff link did not route as a path')
      }

      const sendRequest = vi.fn(async () =>
        ok({
          worktree: targetId,
          relativePath: '',
          absolutePath: targetPath,
          exists: true,
          isDirectory: true
        })
      )
      const options = {
        ...createOptions(sendRequest),
        worktreeId:
          'd11c8322-62d2-4992-9091-9706d68c5935::/Users/jinjingliang/Documents/projects/orca-plugins/improve-plugin-category-display',
        activeHandleRef: { current: null },
        getActiveSessionTabId: () => 'agent-tab-1',
        getActiveSessionTabType: () => 'agent-session'
      }
      act(() => {
        renderer = create(
          createElement(
            WorkspaceExecutionHostContext.Provider,
            { value: executionHost },
            createElement(Harness, { options })
          )
        )
      })

      handlers!.handleNativeChatFileTap(route.pathText)
      await act(async () => {})

      expect(sendRequest).toHaveBeenCalledExactlyOnceWith(
        'files.resolveTerminalPath',
        {
          worktree: `id:${options.worktreeId}`,
          pathText: targetPath,
          crossWorkspace: true,
          nativeChatContext: { tabId: 'agent-tab-1', sessionId: 'session-1' }
        },
        { timeoutMs: 10_000 }
      )
      expect(navigate).toHaveBeenCalledTimes(1)
      expect(navigate.mock.calls[0]?.[0]).toEqual({
        pathname: '/h/[hostId]/session/[worktreeId]',
        params: {
          hostId: 'host-1',
          worktreeId: targetId,
          ...(executionHost ? { executionHost } : {})
        }
      })
      expect(push).not.toHaveBeenCalled()
      expect(options.reportChatTapFailure).not.toHaveBeenCalled()
    }
  )

  it('does not navigate a resolved workspace after the user switches chat tabs', async () => {
    let resolveRequest: (reply: RpcResponse) => void = () => {}
    const sendRequest = vi.fn(
      () =>
        new Promise<RpcResponse>((resolve) => {
          resolveRequest = resolve
        })
    )
    let activeTabId = 'agent-tab-1'
    const options = {
      ...createOptions(sendRequest),
      activeHandleRef: { current: null },
      getActiveSessionTabId: () => activeTabId,
      getActiveSessionTabType: () => 'agent-session'
    }
    act(() => {
      renderer = create(createElement(Harness, { options }))
    })

    handlers!.handleNativeChatFileTap('/repo-b')
    activeTabId = 'agent-tab-2'
    resolveRequest(
      ok({
        worktree: 'wt-2',
        absolutePath: '/repo-b',
        relativePath: '',
        exists: true,
        isDirectory: true
      })
    )
    await act(async () => {})

    expect(navigate).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
    expect(options.reportChatTapFailure).not.toHaveBeenCalled()
  })

  it('does not carry a pending workspace resolution into a different host', async () => {
    let resolveRequest: (reply: RpcResponse) => void = () => {}
    const sendRequest = vi.fn(
      () =>
        new Promise<RpcResponse>((resolve) => {
          resolveRequest = resolve
        })
    )
    const options = createOptions(sendRequest)
    act(() => {
      renderer = create(createElement(Harness, { options }))
    })

    handlers!.handleNativeChatFileTap('/repo-b')
    act(() => {
      renderer!.update(createElement(Harness, { options: { ...options, hostId: 'host-2' } }))
    })
    resolveRequest(
      ok({
        worktree: 'wt-2',
        absolutePath: '/repo-b',
        relativePath: '',
        exists: true,
        isDirectory: true
      })
    )
    await act(async () => {})

    expect(navigate).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
    expect(options.reportChatTapFailure).not.toHaveBeenCalled()
  })

  it.each(['blur', 'unmount'])('invalidates pending workspace taps on %s', async (leave) => {
    let resolveRequest: (reply: RpcResponse) => void = () => {}
    const sendRequest = vi.fn(
      () =>
        new Promise<RpcResponse>((resolve) => {
          resolveRequest = resolve
        })
    )
    const options = {
      ...createOptions(sendRequest),
      activeHandleRef: { current: null },
      getActiveSessionTabId: () => 'agent-tab-1',
      getActiveSessionTabType: () => 'agent-session'
    }
    act(() => {
      renderer = create(createElement(Harness, { options }))
    })

    handlers!.handleNativeChatFileTap('/repo-b')
    act(() => {
      if (leave === 'unmount') {
        renderer!.unmount()
        renderer = null
      } else {
        lifecycle.focused = false
        renderer!.update(createElement(Harness, { options }))
      }
    })
    const reply = ok({
      worktree: 'wt-2',
      absolutePath: '/repo-b',
      relativePath: '',
      exists: true,
      isDirectory: true
    })
    resolveRequest(reply)
    await act(async () => {})

    expect(navigate).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
    expect(options.reportChatTapFailure).not.toHaveBeenCalled()

    if (leave === 'blur') {
      act(() => {
        lifecycle.focused = true
        renderer!.update(createElement(Harness, { options }))
      })
      handlers!.handleNativeChatFileTap('/repo-b')
      resolveRequest(reply)
      await act(async () => {})
      expect(navigate).toHaveBeenCalledTimes(1)
    }
  })

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
