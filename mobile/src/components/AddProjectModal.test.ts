import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AddProjectModal } from './AddProjectModal'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { DirEntry } from '../../../src/shared/types'

type MockClient = {
  sendRequest: ReturnType<typeof vi.fn>
}

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  StyleSheet: {
    create: (styles: unknown) => styles,
    hairlineWidth: 1
  },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  ChevronRight: 'ChevronRight',
  Folder: 'Folder',
  FolderGit2: 'FolderGit2',
  FolderPlus: 'FolderPlus'
}))

vi.mock('./BottomDrawer', async () => {
  const React = await import('react')
  return {
    BottomDrawer: ({ visible, children }: { visible: boolean; children: unknown }) =>
      visible ? React.createElement('BottomDrawer', null, children) : null
  }
})

function suppressReactTestRendererDeprecationWarning(): () => void {
  const originalConsoleError = console.error
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    const firstArg = args[0]
    if (typeof firstArg === 'string' && firstArg.includes('react-test-renderer is deprecated')) {
      return
    }
    originalConsoleError(...args)
  })
  return () => consoleErrorSpy.mockRestore()
}

function entry(name: string, isDirectory = true): DirEntry {
  return { name, isDirectory, isSymlink: false }
}

function rpcOk(result: unknown): RpcResponse {
  return { id: 'response-id', ok: true, result, _meta: { runtimeId: 'runtime-id' } }
}

function rpcError(message: string): RpcResponse {
  return {
    id: 'response-id',
    ok: false,
    error: { code: 'internal', message },
    _meta: { runtimeId: 'runtime-id' }
  }
}

type Listing = { resolvedPath: string; entries: DirEntry[] }

function createMockClient(
  listings: Record<string, Listing>,
  onRepoAdd?: (params: Record<string, unknown>) => RpcResponse | Promise<RpcResponse>
): MockClient {
  return {
    sendRequest: vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'files.browseServerDir') {
        const listing = listings[params.path as string]
        if (!listing) {
          throw new Error(`No mock listing for path: ${String(params.path)}`)
        }
        return rpcOk(listing)
      }
      if (method === 'repo.add') {
        return onRepoAdd ? onRepoAdd(params) : rpcOk({})
      }
      throw new Error(`Unexpected RPC method: ${method}`)
    })
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

type ModalProps = {
  visible: boolean
  client: MockClient | null
  onAdded: () => void
  onClose: () => void
}

function modalElement(props: ModalProps) {
  return createElement(AddProjectModal, {
    ...props,
    client: props.client as unknown as RpcClient | null
  })
}

async function renderModal(props: ModalProps): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null
  const restoreConsoleError = suppressReactTestRendererDeprecationWarning()
  try {
    await act(async () => {
      renderer = create(modalElement(props))
    })
  } finally {
    restoreConsoleError()
  }
  if (!renderer) {
    throw new Error('AddProjectModal did not render')
  }
  return renderer
}

async function updateModal(renderer: ReactTestRenderer, props: ModalProps): Promise<void> {
  await act(async () => {
    renderer.update(modalElement(props))
  })
}

function textOf(children: unknown): string {
  return Array.isArray(children) ? children.join('') : String(children)
}

function renderedText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByType('Text')
    .map((node) => textOf(node.props.children))
    .join(' | ')
}

async function pressRowByText(renderer: ReactTestRenderer, text: string): Promise<void> {
  const pressable = renderer.root
    .findAllByType('Pressable')
    .find((node) => node.findAllByType('Text').some((t) => textOf(t.props.children) === text))
  if (!pressable) {
    throw new Error(`Unable to find pressable row with text: ${text}`)
  }
  await act(async () => {
    pressable.props.onPress()
  })
}

async function pressAddButton(renderer: ReactTestRenderer): Promise<void> {
  const pressable = renderer.root
    .findAllByType('Pressable')
    .find((node) =>
      node.findAllByType('Text').some((t) => textOf(t.props.children).startsWith('Add '))
    )
  if (!pressable) {
    throw new Error('Unable to find the Add button')
  }
  await act(async () => {
    pressable.props.onPress()
  })
}

function defaultProps(client: MockClient | null): ModalProps {
  return { visible: true, client, onAdded: vi.fn(), onClose: vi.fn() }
}

describe('AddProjectModal', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('browses the host home on open and lists only visible folders', async () => {
    const client = createMockClient({
      '~': {
        resolvedPath: '/Users/tester',
        entries: [entry('projects'), entry('.hidden'), entry('notes.txt', false)]
      }
    })

    const renderer = await renderModal(defaultProps(client))

    expect(client.sendRequest).toHaveBeenCalledWith(
      'files.browseServerDir',
      { path: '~' },
      { timeoutMs: 15_000 }
    )
    const text = renderedText(renderer)
    expect(text).toContain('/Users/tester')
    expect(text).toContain('projects')
    expect(text).not.toContain('.hidden')
    expect(text).not.toContain('notes.txt')
    expect(text).toContain('Not a git repository — added as a folder project')
    expect(text).toContain('Add "tester"')
  })

  it('navigates into folders and back up through the server-resolved .. path', async () => {
    const client = createMockClient({
      '~': { resolvedPath: '/Users/tester', entries: [entry('projects')] },
      '/Users/tester/projects': {
        resolvedPath: '/Users/tester/projects',
        entries: [entry('orca')]
      },
      '/Users/tester/projects/..': { resolvedPath: '/Users/tester', entries: [entry('projects')] }
    })

    const renderer = await renderModal(defaultProps(client))

    await pressRowByText(renderer, 'projects')
    expect(renderedText(renderer)).toContain('orca')
    expect(renderedText(renderer)).toContain('Add "projects"')

    await pressRowByText(renderer, '..')
    expect(client.sendRequest).toHaveBeenLastCalledWith(
      'files.browseServerDir',
      { path: '/Users/tester/projects/..' },
      { timeoutMs: 15_000 }
    )
    expect(renderedText(renderer)).toContain('Add "tester"')
  })

  it('hides the up row at Unix and Windows filesystem roots', async () => {
    const unixRoot = await renderModal(
      defaultProps(createMockClient({ '~': { resolvedPath: '/', entries: [entry('home')] } }))
    )
    expect(renderedText(unixRoot)).not.toContain('..')

    const windowsRoot = await renderModal(
      defaultProps(createMockClient({ '~': { resolvedPath: 'C:\\', entries: [entry('Users')] } }))
    )
    expect(renderedText(windowsRoot)).not.toContain('..')

    const windowsFolder = await renderModal(
      defaultProps(
        createMockClient({
          '~': { resolvedPath: 'C:\\Users\\dev\\proj', entries: [] }
        })
      )
    )
    expect(renderedText(windowsFolder)).toContain('..')
    expect(renderedText(windowsFolder)).toContain('Add "proj"')
  })

  it('detects a git repo from a .git entry (even a file) and adds with kind git', async () => {
    const client = createMockClient({
      '~': {
        resolvedPath: '/Users/tester/repo',
        // .git as a file covers worktrees/submodules; hidden entries are
        // filtered from the rows but must still feed the git probe.
        entries: [entry('.git', false), entry('src')]
      }
    })
    const props = defaultProps(client)

    const renderer = await renderModal(props)
    expect(renderedText(renderer)).toContain('Git repository')

    await pressAddButton(renderer)

    expect(client.sendRequest).toHaveBeenLastCalledWith(
      'repo.add',
      { path: '/Users/tester/repo', kind: 'git' },
      { timeoutMs: 30_000 }
    )
    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(props.onAdded).toHaveBeenCalledTimes(1)
  })

  it('adds non-git folders with kind folder', async () => {
    const client = createMockClient({
      '~': { resolvedPath: '/Users/tester/notes', entries: [entry('drafts')] }
    })
    const props = defaultProps(client)

    const renderer = await renderModal(props)
    await pressAddButton(renderer)

    expect(client.sendRequest).toHaveBeenLastCalledWith(
      'repo.add',
      { path: '/Users/tester/notes', kind: 'folder' },
      { timeoutMs: 30_000 }
    )
    expect(props.onAdded).toHaveBeenCalledTimes(1)
  })

  it('shows the server error inline when add fails and keeps the modal open', async () => {
    const client = createMockClient({ '~': { resolvedPath: '/Users/tester', entries: [] } }, () =>
      rpcError('Path is not a git repository')
    )
    const props = defaultProps(client)

    const renderer = await renderModal(props)
    await pressAddButton(renderer)

    expect(renderedText(renderer)).toContain('Path is not a git repository')
    expect(props.onClose).not.toHaveBeenCalled()
    expect(props.onAdded).not.toHaveBeenCalled()
  })

  it('ignores a stale repo.add completion after the drawer is closed and reopened', async () => {
    const pendingAdd = deferred<RpcResponse>()
    const client = createMockClient(
      { '~': { resolvedPath: '/Users/tester', entries: [] } },
      () => pendingAdd.promise
    )
    const props = defaultProps(client)

    const renderer = await renderModal(props)
    await pressAddButton(renderer)

    // User closes the drawer while repo.add is still in flight, then reopens.
    await updateModal(renderer, { ...props, visible: false })
    await updateModal(renderer, { ...props, visible: true })

    await act(async () => {
      pendingAdd.resolve(rpcOk({}))
      await pendingAdd.promise
    })

    // The stale completion must not close/refresh the reopened session.
    expect(props.onClose).not.toHaveBeenCalled()
    expect(props.onAdded).not.toHaveBeenCalled()
    expect(renderedText(renderer)).toContain('Add "tester"')
  })

  it('caps the rendered folder list and reports the truncation', async () => {
    const entries = Array.from({ length: 301 }, (_, i) =>
      entry(`dir-${String(i).padStart(3, '0')}`)
    )
    const client = createMockClient({
      '~': { resolvedPath: '/Users/tester', entries }
    })

    const renderer = await renderModal(defaultProps(client))

    const text = renderedText(renderer)
    expect(text).toContain('Showing 300 of 301 folders')
    expect(text).toContain('dir-000')
    expect(text).not.toContain('dir-300')
  })
})
