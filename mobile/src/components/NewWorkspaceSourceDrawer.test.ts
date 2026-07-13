import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { NewWorkspaceSourceDrawer } from './NewWorkspaceSourceDrawer'

const sourceRpc = vi.hoisted(() => ({
  searchWorkspaceSources: vi.fn(),
  resolveWorkspaceSourcePr: vi.fn()
}))

vi.mock('../workspace-source/workspace-source-rpc', () => ({
  NEW_WORKSPACE_SOURCE_RESULT_LIMIT: 12,
  resolveWorkspaceSourcePr: sourceRpc.resolveWorkspaceSourcePr,
  searchWorkspaceSources: sourceRpc.searchWorkspaceSources
}))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  FlatList: 'FlatList',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  CircleDot: 'CircleDot',
  GitBranch: 'GitBranch',
  GitPullRequest: 'GitPullRequest',
  ListTodo: 'ListTodo'
}))

vi.mock('./BottomDrawer', () => ({ BottomDrawer: 'BottomDrawer' }))
vi.mock('./MobileSearchField', () => ({ MobileSearchField: 'MobileSearchField' }))

const client = { sendRequest: vi.fn() } as unknown as RpcClient
const initialAvailability = { github: true, branches: true, linear: false }
const initialResult = {
  rows: [
    {
      kind: 'github',
      key: 'github:issue:1',
      item: {
        id: 'issue-1',
        type: 'issue',
        number: 1,
        title: 'First issue',
        url: 'https://github.com/acme/app/issues/1',
        repoId: 'repo-1',
        state: 'open',
        labels: [],
        updatedAt: '',
        author: null
      }
    }
  ],
  warnings: [],
  errors: []
}

const prResult = {
  ...initialResult,
  rows: [
    {
      kind: 'github',
      key: 'github:pr:2',
      item: {
        ...initialResult.rows[0]!.item,
        id: 'pr-2',
        type: 'pr',
        number: 2,
        title: 'Second PR',
        url: 'https://github.com/acme/app/pull/2'
      }
    }
  ]
}

function suppressReactTestRendererDeprecationWarning(): () => void {
  const originalConsoleError = console.error
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    const firstArg = args[0]
    if (typeof firstArg === 'string' && firstArg.includes('react-test-renderer is deprecated')) {
      return
    }
    originalConsoleError(...args)
  })
  return () => spy.mockRestore()
}

function drawerProps(
  overrides: Partial<Parameters<typeof NewWorkspaceSourceDrawer>[0]> = {}
): Parameters<typeof NewWorkspaceSourceDrawer>[0] {
  return {
    visible: true,
    client,
    repoId: 'repo-1',
    availability: initialAvailability,
    sshStateGeneration: 0,
    name: { value: '', owner: 'blank' },
    worktreeBranches: [],
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onOpen: vi.fn(),
    ...overrides
  }
}

async function mountDrawer(
  overrides: Partial<Parameters<typeof NewWorkspaceSourceDrawer>[0]> = {}
): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null
  const restoreConsoleError = suppressReactTestRendererDeprecationWarning()
  try {
    await act(async () => {
      renderer = create(createElement(NewWorkspaceSourceDrawer, drawerProps(overrides)))
      await Promise.resolve()
      await Promise.resolve()
    })
  } finally {
    restoreConsoleError()
  }
  if (!renderer) {
    throw new Error('workspace source drawer did not render')
  }
  return renderer
}

function renderedRows(renderer: ReactTestRenderer): unknown[] {
  return renderer.root.findByType('FlatList').props.data as unknown[]
}

describe('NewWorkspaceSourceDrawer result generations', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    sourceRpc.searchWorkspaceSources.mockReset()
    sourceRpc.resolveWorkspaceSourcePr.mockReset()
    sourceRpc.searchWorkspaceSources
      .mockResolvedValueOnce(initialResult)
      .mockReturnValue(new Promise(() => {}))
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('removes prior rows immediately when the query enters debounce', async () => {
    renderer = await mountDrawer()
    expect(renderedRows(renderer)).toHaveLength(1)

    act(() => {
      renderer?.root.findByType('MobileSearchField').props.onChangeText('second')
    })

    expect(renderedRows(renderer)).toEqual([])
  })

  it('removes prior rows immediately when the filter changes', async () => {
    renderer = await mountDrawer()
    const githubFilter = renderer.root
      .findAllByType('Pressable')
      .find((node) => node.props.accessibilityLabel === 'GitHub source filter')

    act(() => githubFilter?.props.onPress())

    expect(renderedRows(renderer)).toEqual([])
  })

  it('removes prior rows immediately when source availability changes', async () => {
    renderer = await mountDrawer()

    act(() => {
      renderer?.update(
        createElement(
          NewWorkspaceSourceDrawer,
          drawerProps({ availability: { github: false, branches: false, linear: true } })
        )
      )
    })

    expect(renderedRows(renderer)).toEqual([])
  })

  it('ignores search results from before a same-availability SSH transition', async () => {
    let resolveStaleSearch: ((value: typeof initialResult) => void) | null = null
    sourceRpc.searchWorkspaceSources
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStaleSearch = resolve
          })
      )
      .mockReturnValueOnce(new Promise(() => {}))
    renderer = await mountDrawer()

    act(() => {
      renderer?.update(
        createElement(NewWorkspaceSourceDrawer, drawerProps({ sshStateGeneration: 1 }))
      )
    })
    await act(async () => {
      resolveStaleSearch?.(initialResult)
      await Promise.resolve()
    })

    expect(sourceRpc.searchWorkspaceSources).toHaveBeenCalledTimes(2)
    expect(renderedRows(renderer)).toEqual([])
  })

  it('ignores PR resolution from before a same-availability SSH transition', async () => {
    sourceRpc.searchWorkspaceSources.mockReset().mockResolvedValue(prResult)
    let resolveStalePr: ((value: { baseBranch: string; compareBaseRef: string }) => void) | null =
      null
    sourceRpc.resolveWorkspaceSourcePr.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStalePr = resolve
        })
    )
    const onSelect = vi.fn()
    renderer = await mountDrawer({ onSelect })

    act(() => {
      renderer!.root
        .findByType('FlatList')
        .props.renderItem({ item: prResult.rows[0] })
        .props.onPress()
    })
    act(() => {
      renderer?.update(
        createElement(NewWorkspaceSourceDrawer, drawerProps({ onSelect, sshStateGeneration: 1 }))
      )
    })
    await act(async () => {
      resolveStalePr?.({ baseBranch: 'main', compareBaseRef: 'origin/main' })
      await Promise.resolve()
    })

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('releases PR selection ownership when closed and keeps a reopened request isolated', async () => {
    vi.useFakeTimers()
    sourceRpc.searchWorkspaceSources.mockReset().mockResolvedValue(prResult)
    let resolveFirst: ((value: { baseBranch: string; compareBaseRef: string }) => void) | null =
      null
    sourceRpc.resolveWorkspaceSourcePr
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockReturnValueOnce(new Promise(() => {}))
    renderer = await mountDrawer()

    const renderRow = () =>
      renderer!.root.findByType('FlatList').props.renderItem({ item: prResult.rows[0] })
    const pressRenderedRow = (): void => {
      renderRow().props.onPress()
    }
    act(pressRenderedRow)
    const pendingRow = renderRow()
    expect(pendingRow.props.disabled).toBe(true)
    expect(pendingRow.props.accessibilityState).toEqual({ disabled: true })
    expect(pendingRow.props.children[2].props.children).toBeNull()

    await act(async () => vi.advanceTimersByTimeAsync(199))
    expect(renderRow().props.children[2].props.children).toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(renderRow().props.children[2].props.children.type).toBe('ActivityIndicator')

    act(() =>
      renderer?.update(createElement(NewWorkspaceSourceDrawer, drawerProps({ visible: false })))
    )
    await act(async () => {
      renderer?.update(createElement(NewWorkspaceSourceDrawer, drawerProps()))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(
      renderer.root.findByType('FlatList').props.renderItem({ item: prResult.rows[0] }).props
        .disabled
    ).toBe(false)

    act(pressRenderedRow)
    expect(sourceRpc.resolveWorkspaceSourcePr).toHaveBeenCalledTimes(2)
    act(() => resolveFirst?.({ baseBranch: 'main', compareBaseRef: 'origin/main' }))
    await act(async () => {
      await Promise.resolve()
    })
    act(pressRenderedRow)
    expect(sourceRpc.resolveWorkspaceSourcePr).toHaveBeenCalledTimes(2)
  })
})
