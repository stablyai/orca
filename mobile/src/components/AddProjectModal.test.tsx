import { createElement, type ElementType } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'android', select: (options: { android?: unknown }) => options.android },
  Pressable: 'Pressable',
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
vi.mock('./BottomDrawer', () => ({ BottomDrawer: 'BottomDrawer' }))

import { REPO_CLONE_TIMEOUT_MS } from '../tasks/workspace-create-timeout'
import { AddProjectModal } from './AddProjectModal'
import { ActionSheetContent } from './ActionSheetModal'

const repoRow = {
  id: 'repo-added',
  path: '/srv/fresh-clone',
  displayName: 'fresh-clone',
  badgeColor: '#aabbcc',
  kind: 'git'
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

describe('AddProjectModal', () => {
  let renderer: ReactTestRenderer
  const onClose = vi.fn()
  const onProjectAdded = vi.fn()

  function render(sendRequest: ReturnType<typeof vi.fn>, visible = true): ReactTestRenderer {
    const client = { sendRequest } as unknown as RpcClient
    act(() => {
      renderer = create(
        createElement(AddProjectModal, {
          visible,
          client,
          onProjectAdded,
          onClose
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
    expect(startActions(tree).map((action) => [action.label, action.hint])).toEqual([
      ['Browse folder', 'Existing Git repository or folder on this host'],
      ['Clone from URL', 'Clone a remote Git repository'],
      ['Create new project', 'Start from an empty folder']
    ])
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
    const drawer = tree.root.findByType(hostType('BottomDrawer'))
    act(() =>
      renderer.update(
        createElement(AddProjectModal, {
          visible: false,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the re-render reuses the same partial client; only sendRequest is read before the drawer closes.
          client: { sendRequest } as unknown as RpcClient,
          onProjectAdded,
          onClose
        })
      )
    )
    act(() => drawer.props.onAfterClose())
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

  it('sends the typed host path for an existing folder', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValue({ ok: true, result: { repo: repoRow }, _meta: { runtimeId: 'r' } })
    const tree = render(sendRequest)

    act(() =>
      startActions(tree)
        .find((a) => a.label === 'Browse folder')!
        .onPress()
    )
    act(() => textInputs(tree)[0]!.props.onChangeText('/srv/orca'))
    act(() => button(tree, 'Add project').props.onPress())
    await flushUpdates()

    expect(sendRequest).toHaveBeenCalledWith('repo.add', { path: '/srv/orca' })
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
})
