import { createElement, Fragment, startTransition, Suspense, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalQuickCommand } from '../../../../src/shared/terminal/quick-commands/terminal-quick-command-types'
import { QuickCommandsSheet } from './QuickCommandsSheet'
import { createStableLogicalRpcClient } from '../../transport/connection/stable-logical-rpc-client'
import { FakeSession } from '../../transport/connection/mobile-endpoint-supervisor-test-fakes'

import {
  findAllByHostType,
  findByHostType
} from '../../test-support/react-test-renderer-host-nodes'

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

vi.mock('../../components/bottom-drawer/BottomDrawer', () => ({
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
    expect(editor().props.draft.label).toBe('Newer')
    expect(editor().props.saving).toBe(false)
    client.close()
  })
})
