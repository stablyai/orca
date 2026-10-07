import { createElement, type ElementType, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'android', select: (options: { android?: unknown }) => options.android },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))
// Every icon in the sheet tree renders as a host element named after itself.
vi.mock(
  'lucide-react-native',
  () =>
    new Proxy(
      {},
      {
        get: (_target, name) => (typeof name === 'string' ? name : undefined),
        has: () => true
      }
    )
)
vi.mock('./BottomDrawer', () => ({
  BottomDrawer: ({
    children,
    contentScrollable,
    ...props
  }: {
    children?: ReactNode
    contentScrollable?: boolean
    [key: string]: unknown
  }) =>
    createElement(
      contentScrollable ? 'ScrollView' : 'View',
      { ...props, testID: 'bottom-drawer-wrapper' },
      children
    )
}))

import { REPO_CLONE_TIMEOUT_MS } from '../tasks/workspace-create-timeout'
import { REPO_ADD_PROJECT_SSH_MOBILE_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import { AddProjectFolderBrowser } from './AddProjectFolderBrowser'
import { AddProjectModal } from './AddProjectModal'
import { ActionSheetContent } from './ActionSheetModal'
import { ConfirmContent } from './ConfirmModal'

const repoRow = {
  id: 'repo-added',
  path: '/srv/fresh-clone',
  displayName: 'fresh-clone',
  badgeColor: '#aabbcc',
  kind: 'git'
}

/** A files.browseServerDir reply: `dirs` list as directories, `files` as plain files. */
function listing(resolvedPath: string, dirs: string[], files: string[] = []) {
  return {
    ok: true,
    result: {
      resolvedPath,
      entries: [
        ...dirs.map((name) => ({ name, isDirectory: true, isSymlink: false })),
        ...files.map((name) => ({ name, isDirectory: false, isSymlink: false }))
      ]
    },
    _meta: { runtimeId: 'r' }
  }
}

// ElementType only admits DOM intrinsics in this program, while the react-native mock renders
// each export as a host element named after itself — one bridged lookup for those names.
function hostType(name: string): ElementType {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the react-native mock maps every export to a plain string element type, so the runtime type is exactly this string.
  return name as ElementType
}

function textInputs(tree: ReactTestRenderer): ReactTestInstance[] {
  return tree.root.findAllByType(hostType('TextInput'))
}

function button(tree: ReactTestRenderer, label: string): ReactTestInstance {
  const found = tree.root.findAll((node) => node.props.accessibilityLabel === label)
  if (found.length === 0) {
    throw new Error(`no element labelled ${label}`)
  }
  return found[0]!
}

function drawer(tree: ReactTestRenderer): ReactTestInstance {
  return tree.root.findByProps({ testID: 'bottom-drawer-wrapper' })
}

function startActions(tree: ReactTestRenderer) {
  const sheet = tree.root.findByType(ActionSheetContent)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ActionSheetContent is the mock, whose actions prop is exactly the label/hint/onPress rows each test passes.
  return sheet.props.actions as { label: string; hint: string; onPress: () => void }[]
}

async function flushUpdates(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 5; turn++) {
      await Promise.resolve()
    }
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('AddProjectModal', () => {
  let renderer: ReactTestRenderer
  const onClose = vi.fn()
  const onProjectAdded = vi.fn()

  function render(
    sendRequest: ReturnType<typeof vi.fn>,
    visible = true,
    hostCapabilities: readonly string[] = [],
    sshTargets: readonly { id: string; label: string }[] = []
  ): ReactTestRenderer {
    const client = { sendRequest } as unknown as RpcClient
    act(() => {
      renderer = create(
        createElement(AddProjectModal, {
          visible,
          client,
          onProjectAdded,
          onClose,
          hostCapabilities,
          sshTargets
        })
      )
    })
    return renderer
  }

  beforeEach(() => {
    onClose.mockClear()
    onProjectAdded.mockClear()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
  })

  it('mirrors the desktop start rows minus SSH', () => {
    const tree = render(vi.fn())
    expect(drawer(tree).type).toBe(hostType('ScrollView'))
    expect(startActions(tree).map((action) => [action.label, action.hint])).toEqual([
      ['Browse folder', 'Existing Git repository or folder on this host'],
      ['Clone from URL', 'Clone a remote Git repository'],
      ['Create new project', 'Start from an empty folder']
    ])
  })

  it('gates SSH targets on the host capability and keeps old-host payloads unchanged', () => {
    const oldHost = render(vi.fn())
    expect(() => button(oldHost, 'Run on This host')).toThrow()
    act(() => oldHost.unmount())

    const capableHost = render(
      vi.fn(),
      true,
      [REPO_ADD_PROJECT_SSH_MOBILE_RUNTIME_CAPABILITY],
      [{ id: 'ssh-vm', label: 'Build VM' }]
    )
    expect(button(capableHost, 'Run on This host')).toBeDefined()
    act(() => button(capableHost, 'Run on This host').props.onPress())
    expect(button(capableHost, 'Select Build VM')).toBeDefined()
  })

  it('uses the selected SSH target for browse and clone while local stays the default', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(listing('/home/remote', ['projects']))
      .mockResolvedValueOnce(listing('/home/remote', ['projects']))
      .mockResolvedValue({ ok: true, result: { repo: repoRow }, _meta: { runtimeId: 'r' } })
    const tree = render(
      sendRequest,
      true,
      [REPO_ADD_PROJECT_SSH_MOBILE_RUNTIME_CAPABILITY],
      [{ id: 'ssh-vm', label: 'Build VM' }]
    )
    act(() => button(tree, 'Run on This host').props.onPress())
    act(() => button(tree, 'Select Build VM').props.onPress())
    act(() =>
      startActions(tree)
        .find((a) => a.label === 'Browse folder')!
        .onPress()
    )
    await flushUpdates()
    expect(sendRequest).toHaveBeenNthCalledWith(1, 'files.browseServerDir', {
      path: '~',
      sshConnectionId: 'ssh-vm'
    })

    act(() => button(tree, 'Back to Add project').props.onPress())
    act(() =>
      startActions(tree)
        .find((a) => a.label === 'Clone from URL')!
        .onPress()
    )
    await flushUpdates()
    act(() => button(tree, 'Select folder').props.onPress())
    act(() => textInputs(tree)[0]!.props.onChangeText('https://example.com/repo.git'))
    act(() => textInputs(tree)[0]!.props.onChangeText('https://example.com/repo.git'))
    act(() => button(tree, 'Clone repository').props.onPress())
    await flushUpdates()
    expect(sendRequest).toHaveBeenLastCalledWith(
      'repo.clone',
      {
        url: 'https://example.com/repo.git',
        destination: '/home/remote',
        sshConnectionId: 'ssh-vm'
      },
      { timeoutMs: REPO_CLONE_TIMEOUT_MS }
    )
  })

  it('gives the folder browser the only list scroll and resets it on reopen', async () => {
    const sendRequest = vi.fn().mockResolvedValue(listing('/home/dev', ['projects']))
    const tree = render(sendRequest)

    act(() =>
      startActions(tree)
        .find((action) => action.label === 'Browse folder')!
        .onPress()
    )
    await flushUpdates()
    expect(drawer(tree).type).toBe(hostType('View'))

    act(() => button(tree, 'Back to Add project').props.onPress())
    expect(drawer(tree).type).toBe(hostType('ScrollView'))

    act(() =>
      startActions(tree)
        .find((action) => action.label === 'Browse folder')!
        .onPress()
    )
    await flushUpdates()
    expect(drawer(tree).type).toBe(hostType('View'))

    const client = tree.root.findByType(AddProjectModal).props.client
    act(() =>
      renderer.update(
        createElement(AddProjectModal, {
          visible: false,
          client,
          onProjectAdded,
          onClose
        })
      )
    )
    act(() =>
      renderer.update(
        createElement(AddProjectModal, {
          visible: true,
          client,
          onProjectAdded,
          onClose
        })
      )
    )
    expect(drawer(tree).type).toBe(hostType('ScrollView'))
  })

  it('clones with the URL alone, then hands the repo off only after the sheet closed', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValue({ ok: true, result: { repo: repoRow }, _meta: { runtimeId: 'r' } })
    const tree = render(sendRequest)

    act(() =>
      startActions(tree)
        .find((a) => a.label === 'Clone from URL')!
        .onPress()
    )
    act(() => textInputs(tree)[0]!.props.onChangeText('  https://example.com/orca.git  '))
    act(() => button(tree, 'Clone repository').props.onPress())

    await flushUpdates()
    expect(sendRequest).toHaveBeenCalledWith(
      'repo.clone',
      { url: 'https://example.com/orca.git' },
      { timeoutMs: REPO_CLONE_TIMEOUT_MS }
    )
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onProjectAdded).not.toHaveBeenCalled()

    // The handoff waits for the drawer's onAfterClose: presenting the New workspace
    // modal any earlier is the iOS same-beat race the sheet exists to avoid.
    const drawerNode = drawer(tree)
    act(() =>
      renderer.update(
        createElement(AddProjectModal, {
          visible: false,
          client: tree.root.findByType(AddProjectModal).props.client,
          onProjectAdded,
          onClose
        })
      )
    )
    act(() => drawerNode.props.onAfterClose())
    expect(onProjectAdded).toHaveBeenCalledWith(repoRow)
  })

  it('raises the soft error a repo.create reply carries inside a successful result', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: { error: 'Name cannot be empty' },
      _meta: { runtimeId: 'r' }
    })
    const tree = render(sendRequest)

    act(() =>
      startActions(tree)
        .find((a) => a.label === 'Create new project')!
        .onPress()
    )
    act(() => textInputs(tree)[0]!.props.onChangeText('app'))
    act(() => button(tree, 'Create project').props.onPress())
    await flushUpdates()

    expect(sendRequest).toHaveBeenCalledWith('repo.create', { name: 'app', kind: 'git' })
    expect(onClose).not.toHaveBeenCalled()
    const errorText = renderer.root
      .findAllByType(hostType('Text'))
      .flatMap((node) => node.props.children)
    expect(errorText).toContain('Name cannot be empty')
  })

  it('walks the host filesystem and adds the folder it lands on', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(listing('/home/dev', ['projects'], ['notes.txt']))
      .mockResolvedValueOnce(listing('/home/dev/projects', ['orca']))
      .mockResolvedValue({ ok: true, result: { repo: repoRow }, _meta: { runtimeId: 'r' } })
    const tree = render(sendRequest)

    act(() =>
      startActions(tree)
        .find((a) => a.label === 'Browse folder')!
        .onPress()
    )
    await flushUpdates()
    // A phone has no way to know a host path, so the sheet opens on the host's own home
    // rather than asking for one to type.
    expect(sendRequest).toHaveBeenNthCalledWith(1, 'files.browseServerDir', { path: '~' })

    act(() => button(tree, 'projects').props.onPress())
    await flushUpdates()
    expect(sendRequest).toHaveBeenNthCalledWith(2, 'files.browseServerDir', {
      path: '/home/dev/projects'
    })
    // Files are never selectable: only a folder can be a project.
    expect(() => button(tree, 'notes.txt')).toThrow()

    act(() => button(tree, 'Add this folder as a project').props.onPress())
    await flushUpdates()
    expect(sendRequest).toHaveBeenLastCalledWith('repo.add', {
      path: '/home/dev/projects',
      kind: 'git'
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows the transport error and drops the spinner when the browse call rejects', async () => {
    const sendRequest = vi.fn().mockRejectedValue(new Error('Connection lost'))
    const tree = render(sendRequest)

    act(() =>
      startActions(tree)
        .find((a) => a.label === 'Browse folder')!
        .onPress()
    )
    await flushUpdates()

    const errorText = tree.root
      .findAllByType(hostType('Text'))
      .flatMap((node) => node.props.children)
    expect(errorText).toContain('Connection lost')
    // A rejected browse must clear loading; the spinner otherwise spins forever.
    expect(tree.root.findAllByType(hostType('ActivityIndicator'))).toHaveLength(0)
  })

  it('offers the folder downgrade only after the host refuses the path', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(listing('/srv', ['legacy']))
      .mockRejectedValueOnce(new Error('Not a valid git repository'))
      .mockResolvedValueOnce({ ok: true, result: { repo: repoRow }, _meta: { runtimeId: 'r' } })
    const tree = render(sendRequest)

    act(() =>
      startActions(tree)
        .find((a) => a.label === 'Browse folder')!
        .onPress()
    )
    await flushUpdates()
    act(() => button(tree, 'Add this folder as a project').props.onPress())
    await flushUpdates()

    expect(sendRequest).toHaveBeenLastCalledWith('repo.add', { path: '/srv', kind: 'git' })
    const confirm = tree.root.findByType(ConfirmContent)
    expect(confirm.props.message).toContain('not a Git repository')

    // ConfirmContent fires onCancel on confirm; the sheet must survive that beat, so the
    // browser a refusal falls back to is not the one a success flashes through.
    act(() => {
      confirm.props.onConfirm()
      confirm.props.onCancel()
    })
    // The browser behind a confirmed add would be a flash, not a destination.
    expect(tree.root.findAllByType(AddProjectFolderBrowser)).toHaveLength(0)

    await flushUpdates()
    expect(sendRequest).toHaveBeenLastCalledWith('repo.add', { path: '/srv', kind: 'folder' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('walks a Windows host with the separator that host used', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(listing('C:\\Users\\dev', ['projects']))
      .mockResolvedValueOnce(listing('C:\\Users\\dev\\projects', []))
      .mockResolvedValueOnce(listing('C:\\Users\\dev', ['projects']))
      .mockResolvedValueOnce(listing('C:\\Users', ['dev']))
      .mockResolvedValue(listing('C:\\', ['Users']))
    const tree = render(sendRequest)

    act(() =>
      startActions(tree)
        .find((a) => a.label === 'Browse folder')!
        .onPress()
    )
    await flushUpdates()
    act(() => button(tree, 'projects').props.onPress())
    await flushUpdates()
    expect(sendRequest).toHaveBeenNthCalledWith(2, 'files.browseServerDir', {
      path: 'C:\\Users\\dev\\projects'
    })

    act(() => button(tree, 'Parent folder').props.onPress())
    await flushUpdates()
    expect(sendRequest).toHaveBeenNthCalledWith(3, 'files.browseServerDir', {
      path: 'C:\\Users\\dev'
    })
    act(() => button(tree, 'Parent folder').props.onPress())
    await flushUpdates()
    // A drive root keeps its separator — "C:" alone is drive-relative on Windows.
    expect(sendRequest).toHaveBeenNthCalledWith(4, 'files.browseServerDir', { path: 'C:\\Users' })
    act(() => button(tree, 'Parent folder').props.onPress())
    await flushUpdates()
    expect(sendRequest).toHaveBeenNthCalledWith(5, 'files.browseServerDir', { path: 'C:\\' })

    act(() => button(tree, 'Parent folder').props.onPress())
    await flushUpdates()
    // The mounted-drive list is the Windows top; a drive root has nothing above it.
    expect(sendRequest).toHaveBeenNthCalledWith(6, 'files.browseServerDir', { path: '/' })
  })

  it('returns to the browser when the folder downgrade is declined', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(listing('/srv', ['legacy']))
      .mockRejectedValueOnce(new Error('Not a valid git repository'))
      .mockResolvedValue(listing('/srv', ['legacy']))
    const tree = render(sendRequest)

    act(() =>
      startActions(tree)
        .find((a) => a.label === 'Browse folder')!
        .onPress()
    )
    await flushUpdates()
    act(() => button(tree, 'Add this folder as a project').props.onPress())
    await flushUpdates()

    await act(async () => {
      tree.root.findByType(ConfirmContent).props.onCancel()
      await Promise.resolve()
    })
    expect(tree.root.findByType(AddProjectFolderBrowser)).toBeDefined()
    expect(sendRequest).not.toHaveBeenCalledWith(
      'repo.add',
      expect.objectContaining({ kind: 'folder' })
    )
    expect(onClose).not.toHaveBeenCalled()
  })

  it('keeps the submit button disabled until the field has content', () => {
    const tree = render(vi.fn())
    act(() =>
      startActions(tree)
        .find((a) => a.label === 'Clone from URL')!
        .onPress()
    )

    const submit = button(tree, 'Clone repository')
    expect(submit.props.disabled).toBe(true)
    act(() => textInputs(tree)[0]!.props.onChangeText('https://example.com/orca.git'))
    expect(button(tree, 'Clone repository').props.disabled).toBe(false)
  })

  it('keeps one operation busy across metadata array refreshes', async () => {
    const pending = deferred<ReturnType<typeof listing>>()
    const sendRequest = vi.fn().mockReturnValue(pending.promise)
    const tree = render(sendRequest)
    act(() =>
      startActions(tree)
        .find((a) => a.label === 'Clone from URL')!
        .onPress()
    )
    act(() => textInputs(tree)[0]!.props.onChangeText('https://example.com/orca.git'))
    act(() => button(tree, 'Clone repository').props.onPress())

    const client = tree.root.findByType(AddProjectModal).props.client
    act(() =>
      renderer.update(
        createElement(AddProjectModal, {
          visible: true,
          client,
          onProjectAdded,
          onClose,
          hostCapabilities: [],
          sshTargets: []
        })
      )
    )
    expect(button(tree, 'Clone repository').props.disabled).toBe(true)
    act(() => button(tree, 'Clone repository').props.onPress())
    expect(sendRequest).toHaveBeenCalledTimes(1)

    pending.resolve({ ok: true, result: { repo: repoRow }, _meta: { runtimeId: 'r' } })
    await flushUpdates()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('blocks submit when the selected SSH target disappears instead of falling back local', () => {
    const sendRequest = vi.fn()
    const tree = render(
      sendRequest,
      true,
      [REPO_ADD_PROJECT_SSH_MOBILE_RUNTIME_CAPABILITY],
      [{ id: 'ssh-vm', label: 'Build VM' }]
    )
    act(() => button(tree, 'Run on This host').props.onPress())
    act(() => button(tree, 'Select Build VM').props.onPress())
    act(() =>
      startActions(tree)
        .find((a) => a.label === 'Clone from URL')!
        .onPress()
    )
    act(() => button(tree, 'Select folder').props.onPress())

    const client = tree.root.findByType(AddProjectModal).props.client
    act(() =>
      renderer.update(
        createElement(AddProjectModal, {
          visible: true,
          client,
          onProjectAdded,
          onClose,
          hostCapabilities: [REPO_ADD_PROJECT_SSH_MOBILE_RUNTIME_CAPABILITY],
          sshTargets: []
        })
      )
    )
    act(() => textInputs(tree)[0]!.props.onChangeText('https://example.com/orca.git'))
    expect(button(tree, 'Clone repository').props.disabled).toBe(true)
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest).toHaveBeenLastCalledWith('files.browseServerDir', {
      path: '~',
      sshConnectionId: 'ssh-vm'
    })
  })

  it('ignores a reply retained through close and reopen', async () => {
    const pending = deferred<unknown>()
    const sendRequest = vi.fn().mockReturnValue(pending.promise)
    const tree = render(sendRequest)
    act(() =>
      startActions(tree)
        .find((a) => a.label === 'Clone from URL')!
        .onPress()
    )
    act(() => textInputs(tree)[0]!.props.onChangeText('https://example.com/orca.git'))
    act(() => button(tree, 'Clone repository').props.onPress())
    const client = tree.root.findByType(AddProjectModal).props.client
    const oldDrawer = drawer(tree)
    const afterClose = oldDrawer.props.onAfterClose
    act(() =>
      renderer.update(
        createElement(AddProjectModal, { visible: false, client, onProjectAdded, onClose })
      )
    )
    act(() =>
      renderer.update(
        createElement(AddProjectModal, { visible: true, client, onProjectAdded, onClose })
      )
    )
    pending.resolve({ ok: true, result: { repo: repoRow }, _meta: { runtimeId: 'r' } })
    await flushUpdates()
    act(() => afterClose())
    expect(onProjectAdded).not.toHaveBeenCalled()
  })

  it('lets a new client submit while the old client settles without clearing it', async () => {
    const oldPending = deferred<unknown>()
    const newPending = deferred<unknown>()
    const oldSend = vi.fn().mockReturnValue(oldPending.promise)
    const newSend = vi.fn().mockReturnValue(newPending.promise)
    const tree = render(oldSend)
    act(() =>
      startActions(tree)
        .find((a) => a.label === 'Clone from URL')!
        .onPress()
    )
    act(() => textInputs(tree)[0]!.props.onChangeText('https://example.com/orca.git'))
    act(() => button(tree, 'Clone repository').props.onPress())
    const oldClient = tree.root.findByType(AddProjectModal).props.client
    const newClient = { ...oldClient, sendRequest: newSend }
    act(() =>
      renderer.update(
        createElement(AddProjectModal, {
          visible: true,
          client: newClient,
          onProjectAdded,
          onClose
        })
      )
    )
    act(() => button(tree, 'Clone repository').props.onPress())
    expect(newSend).toHaveBeenCalledTimes(1)
    oldPending.reject(new Error('old client failed'))
    await flushUpdates()
    expect(button(tree, 'Clone repository').props.disabled).toBe(true)
    newPending.resolve({ ok: true, result: { repo: repoRow }, _meta: { runtimeId: 'r' } })
    await flushUpdates()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(oldClient).not.toBe(newClient)
  })

  it('does not hand off after a successful add when the client changes during close', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValue({ ok: true, result: { repo: repoRow }, _meta: { runtimeId: 'r' } })
    const tree = render(sendRequest)
    act(() =>
      startActions(tree)
        .find((a) => a.label === 'Clone from URL')!
        .onPress()
    )
    act(() => textInputs(tree)[0]!.props.onChangeText('https://example.com/orca.git'))
    act(() => button(tree, 'Clone repository').props.onPress())
    await flushUpdates()
    const oldDrawer = drawer(tree)
    const newClient = {
      ...tree.root.findByType(AddProjectModal).props.client,
      sendRequest: vi.fn()
    }
    act(() =>
      renderer.update(
        createElement(AddProjectModal, {
          visible: false,
          client: newClient,
          onProjectAdded,
          onClose
        })
      )
    )
    act(() => oldDrawer.props.onAfterClose())
    expect(onProjectAdded).not.toHaveBeenCalled()
  })

  it('rejects a captured submit handler after its SSH target changes', () => {
    const sendRequest = vi.fn()
    const tree = render(
      sendRequest,
      true,
      [REPO_ADD_PROJECT_SSH_MOBILE_RUNTIME_CAPABILITY],
      [
        { id: 'ssh-a', label: 'A' },
        { id: 'ssh-b', label: 'B' }
      ]
    )
    act(() => button(tree, 'Run on This host').props.onPress())
    act(() => button(tree, 'Select A').props.onPress())
    act(() =>
      startActions(tree)
        .find((a) => a.label === 'Clone from URL')!
        .onPress()
    )
    act(() => button(tree, 'Select folder').props.onPress())
    act(() => textInputs(tree)[0]!.props.onChangeText('https://example.com/orca.git'))
    const oldSubmit = button(tree, 'Clone repository').props.onPress
    act(() => button(tree, 'Back to Add project').props.onPress())
    act(() => button(tree, 'Run on A').props.onPress())
    act(() => button(tree, 'Select B').props.onPress())
    sendRequest.mockClear()
    act(() => oldSubmit())
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('rejects a captured folder pick after its SSH target disappears', async () => {
    const sendRequest = vi.fn().mockResolvedValue(listing('/home/remote', ['projects']))
    const tree = render(
      sendRequest,
      true,
      [REPO_ADD_PROJECT_SSH_MOBILE_RUNTIME_CAPABILITY],
      [{ id: 'ssh-a', label: 'A' }]
    )
    act(() => button(tree, 'Run on This host').props.onPress())
    act(() => button(tree, 'Select A').props.onPress())
    act(() =>
      startActions(tree)
        .find((a) => a.label === 'Browse folder')!
        .onPress()
    )
    await flushUpdates()
    const oldPick = tree.root.findByType(AddProjectFolderBrowser).props.onPick
    const client = tree.root.findByType(AddProjectModal).props.client
    act(() =>
      renderer.update(
        createElement(AddProjectModal, {
          visible: true,
          client,
          onProjectAdded,
          onClose,
          hostCapabilities: [REPO_ADD_PROJECT_SSH_MOBILE_RUNTIME_CAPABILITY],
          sshTargets: []
        })
      )
    )
    act(() => oldPick('/home/remote'))
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest).not.toHaveBeenCalledWith('repo.add', expect.anything())
  })
})
