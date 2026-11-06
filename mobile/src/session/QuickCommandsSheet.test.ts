import { createElement, Fragment, startTransition, Suspense, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalQuickCommand } from '../../../src/shared/terminal/quick-commands/terminal-quick-command-types'
import { QuickCommandsSheet } from './QuickCommandsSheet'
import { createStableLogicalRpcClient } from '../transport/stable-logical-rpc-client'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import { findAllByHostType, findByHostType } from '../test-support/react-test-renderer-host-nodes'

const mocks = vi.hoisted(() => ({
  alert: vi.fn(),
  commands: [] as TerminalQuickCommand[],
  persist: vi.fn()
}))
const quickCommandEditorForm = 'QuickCommandEditorForm'
const quickCommandsList = 'QuickCommandsList'
const suspended = new Promise<void>(() => {})
const suspendedRender = vi.fn()
function Suspend({ active }: { active: boolean }) {
  if (active) {
    suspendedRender()
    throw suspended
  }
  return null
}
vi.mock('react-native', () => ({
  Alert: { alert: mocks.alert },
  Pressable: 'Pressable',
  StyleSheet: { create: <T>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({ ChevronLeft: 'ChevronLeft' }))

vi.mock('../components/bottom-drawer/BottomDrawer', () => ({
  BottomDrawer: ({ children }: { children: ReactNode }) => children
}))

vi.mock('./QuickCommandEditorForm', () => ({
  QuickCommandEditorForm: 'QuickCommandEditorForm'
}))

vi.mock('./QuickCommandsList', () => ({
  QuickCommandAgentPicker: 'QuickCommandAgentPicker',
  QuickCommandsList: 'QuickCommandsList'
}))

vi.mock('./use-quick-commands', () => ({
  useQuickCommands: () => ({
    commands: mocks.commands,
    loading: false,
    ready: true,
    error: null,
    persist: mocks.persist
  })
}))

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('QuickCommandsSheet', () => {
  let renderer: ReactTestRenderer | null = null
  beforeEach(() => {
    mocks.alert.mockReset()
    mocks.commands = []
    mocks.persist.mockReset()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('submits one full-list mutation for a same-frame double tap', async () => {
    const save = deferred<boolean>()
    mocks.persist.mockReturnValue(save.promise)
    await act(async () => {
      renderer = create(
        createElement(QuickCommandsSheet, {
          visible: true,
          onClose: vi.fn(),
          client: stubRpcClient(),
          repoId: 'repo-1',
          repoName: 'Repo',
          agentPromptMaxLength: null,
          onLaunch: () => true
        })
      )
    })

    act(() => findByHostType(renderer!.root, quickCommandsList).props.onAdd())
    const editor = findByHostType(renderer!.root, quickCommandEditorForm)
    act(() => {
      editor.props.onChange({ label: 'Test' })
      editor.props.onChange({ command: 'pnpm test' })
    })
    const readyEditor = findByHostType(renderer!.root, quickCommandEditorForm)
    act(() => {
      readyEditor.props.onSave()
      readyEditor.props.onSave()
    })

    expect(mocks.persist).toHaveBeenCalledTimes(1)
    await act(async () => {
      save.resolve(true)
      await save.promise
    })
  })

  it('keeps save ownership when a repository transition suspends before commit', async () => {
    const save = deferred<boolean>()
    mocks.persist.mockReturnValue(save.promise)
    const onClose = vi.fn()
    const onLaunch = () => true
    const render = (suspend = false) =>
      createElement(
        Suspense,
        { fallback: null },
        createElement(
          Fragment,
          null,
          createElement(QuickCommandsSheet, {
            visible: true,
            client: null,
            repoId: suspend ? 'repo-2' : 'repo-1',
            repoName: 'Repo',
            agentPromptMaxLength: null,
            onClose,
            onLaunch
          }),
          createElement(Suspend, { active: suspend })
        )
      )
    act(() => {
      renderer = create(render())
    })
    act(() => findByHostType(renderer!.root, quickCommandsList).props.onAdd())
    act(() =>
      findByHostType(renderer!.root, quickCommandEditorForm).props.onChange({
        label: 'Test',
        command: 'pnpm test'
      })
    )
    act(() => findByHostType(renderer!.root, quickCommandEditorForm).props.onSave())
    suspendedRender.mockClear()
    act(() => {
      startTransition(() => renderer?.update(render(true)))
    })
    expect(suspendedRender).toHaveBeenCalled()
    await act(async () => {
      save.resolve(true)
      await save.promise
    })
    expect(findAllByHostType(renderer!.root, quickCommandEditorForm)).toHaveLength(0)
    expect(findAllByHostType(renderer!.root, quickCommandsList)).toHaveLength(1)
  })

  it.each(['new editor', 'newer edits'])(
    'preserves %s when an older save completes',
    async (change) => {
      const save = deferred<boolean>()
      mocks.persist.mockReturnValue(save.promise)
      await act(async () => {
        renderer = create(
          createElement(QuickCommandsSheet, {
            visible: true,
            onClose: vi.fn(),
            client: null,
            repoId: 'repo-1',
            repoName: 'Repo',
            agentPromptMaxLength: null,
            onLaunch: () => true
          })
        )
      })
      act(() => findByHostType(renderer!.root, quickCommandsList).props.onAdd())
      act(() =>
        findByHostType(renderer!.root, quickCommandEditorForm).props.onChange({
          label: 'First',
          command: 'first'
        })
      )
      act(() => findByHostType(renderer!.root, quickCommandEditorForm).props.onSave())
      if (change === 'new editor') {
        act(() => findByHostType(renderer!.root, quickCommandEditorForm).props.onCancel())
        act(() => findByHostType(renderer!.root, quickCommandsList).props.onAdd())
      }
      act(() =>
        findByHostType(renderer!.root, quickCommandEditorForm).props.onChange({
          label: 'Second',
          command: 'second'
        })
      )
      await act(async () => {
        save.resolve(true)
        await save.promise
      })
      expect(findAllByHostType(renderer!.root, quickCommandEditorForm)).toHaveLength(1)
      expect(findByHostType(renderer!.root, quickCommandEditorForm).props.draft.label).toBe(
        'Second'
      )
      if (change === 'newer edits') {
        act(() => findByHostType(renderer!.root, quickCommandEditorForm).props.onSave())
        expect(mocks.persist.mock.calls[1]?.[0].command).toMatchObject({
          id: mocks.persist.mock.calls[0]?.[0].command.id,
          label: 'Second',
          command: 'second'
        })
      }
    }
  )

  it.each(['client', 'repo'])('isolates pending saves across a changed %s', async (context) => {
    const first = deferred<boolean>()
    const second = deferred<boolean>()
    mocks.persist.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const props = {
      visible: true,
      onClose: vi.fn(),
      client: null,
      repoId: 'repo-1',
      repoName: 'Repo',
      agentPromptMaxLength: null,
      onLaunch: () => true
    }
    act(() => {
      renderer = create(createElement(QuickCommandsSheet, props))
    })
    act(() => findByHostType(renderer!.root, quickCommandsList).props.onAdd())
    act(() =>
      findByHostType(renderer!.root, quickCommandEditorForm).props.onChange({
        label: 'First',
        command: 'first'
      })
    )
    act(() => findByHostType(renderer!.root, quickCommandEditorForm).props.onSave())
    const nextClient = stubRpcClient()
    act(() =>
      renderer!.update(
        createElement(QuickCommandsSheet, {
          ...props,
          client: context === 'client' ? nextClient : null,
          repoId: context === 'repo' ? 'repo-2' : 'repo-1'
        })
      )
    )
    act(() => findByHostType(renderer!.root, quickCommandsList).props.onAdd())
    act(() =>
      findByHostType(renderer!.root, quickCommandEditorForm).props.onChange({
        label: 'Second',
        command: 'second'
      })
    )
    act(() => findByHostType(renderer!.root, quickCommandEditorForm).props.onSave())
    expect(mocks.persist).toHaveBeenCalledTimes(2)
    await act(async () => {
      first.resolve(true)
      await first.promise
    })
    const editor = findByHostType(renderer!.root, quickCommandEditorForm)
    expect(editor.props.draft.label).toBe('Second')
    expect(editor.props.saving).toBe(true)
    act(() => editor.props.onSave())
    expect(mocks.persist).toHaveBeenCalledTimes(2)
    await act(async () => {
      second.resolve(true)
      await second.promise
    })
    expect(findAllByHostType(renderer!.root, quickCommandEditorForm)).toHaveLength(0)
  })

  it('keeps newer edits and the pending save when the same computer changes connection paths', async () => {
    const saved = deferred<boolean>()
    mocks.persist.mockReturnValue(saved.promise)
    const client = createStableLogicalRpcClient(new FakeSession('connected'), 'relay')
    const props = {
      visible: true,
      onClose: vi.fn(),
      client,
      repoId: 'repo-1',
      repoName: 'Repo',
      agentPromptMaxLength: null,
      onLaunch: () => true
    }
    act(() => {
      renderer = create(createElement(QuickCommandsSheet, props))
    })
    act(() => findByHostType(renderer!.root, quickCommandsList).props.onAdd())
    const editor = () => findByHostType(renderer!.root, quickCommandEditorForm)
    act(() => editor().props.onChange({ label: 'First', command: 'first' }))
    act(() => editor().props.onSave())
    act(() => editor().props.onChange({ label: 'Newer', command: 'newer' }))
    await act(async () => {
      await client.migrateTo(new FakeSession('connected'), 'lan')
      renderer!.update(createElement(QuickCommandsSheet, props))
    })
    expect(editor().props.draft.label).toBe('Newer')
    expect(editor().props.saving).toBe(true)
    await act(async () => {
      saved.resolve(true)
      await saved.promise
    })
    expect(editor().props.draft).toMatchObject({
      label: 'Newer',
      id: mocks.persist.mock.calls[0]?.[0].command.id
    })
    expect(editor().props.saving).toBe(false)
    client.close()
  })
})
