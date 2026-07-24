import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { TerminalQuickCommand } from '../../../src/shared/types'
import type { RpcClient } from '../transport/rpc-client'
import { MAX_QUICK_COMMANDS } from '../terminal/quick-commands'
import { QuickCommandsSheet } from './QuickCommandsSheet'

const mocks = vi.hoisted(() => ({
  alert: vi.fn(),
  commands: [] as TerminalQuickCommand[],
  persist: vi.fn()
}))
const quickCommandEditorForm = 'QuickCommandEditorForm'
const quickCommandsList = 'QuickCommandsList'
const command: TerminalQuickCommand = {
  id: 'command',
  label: 'Test',
  action: 'terminal-command',
  command: 'pnpm test',
  appendEnter: true,
  scope: { type: 'global' }
}

vi.mock('react-native', () => ({
  Alert: { alert: mocks.alert },
  Pressable: 'Pressable',
  StyleSheet: { create: <T>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({ ChevronLeft: 'ChevronLeft' }))

vi.mock('../components/BottomDrawer', () => ({
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
  let consoleSpy: MockInstance

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    mocks.alert.mockReset()
    mocks.commands = []
    mocks.persist.mockReset()
    const originalConsoleError = console.error
    consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      originalConsoleError(...args)
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    consoleSpy.mockRestore()
  })

  it('keeps the sheet open when a launch is rejected', async () => {
    const onClose = vi.fn()
    const onLaunch = vi.fn(() => false)
    await act(async () => {
      renderer = create(
        createElement(QuickCommandsSheet, {
          visible: true,
          onClose,
          client: {} as RpcClient,
          repoId: 'repo-1',
          repoName: 'Repo',
          onLaunch
        })
      )
    })

    act(() => renderer!.root.findByType(quickCommandsList).props.onLaunch(command))

    expect(onLaunch).toHaveBeenCalledWith(command)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('submits one full-list mutation for a same-frame double tap', async () => {
    const save = deferred<boolean>()
    mocks.persist.mockReturnValue(save.promise)
    await act(async () => {
      renderer = create(
        createElement(QuickCommandsSheet, {
          visible: true,
          onClose: vi.fn(),
          client: {} as RpcClient,
          repoId: 'repo-1',
          repoName: 'Repo',
          onLaunch: () => true
        })
      )
    })

    act(() => renderer!.root.findByType(quickCommandsList).props.onAdd())
    const editor = renderer!.root.findByType(quickCommandEditorForm)
    act(() => {
      editor.props.onChange({ label: 'Test' })
      editor.props.onChange({ command: 'pnpm test' })
    })
    const readyEditor = renderer!.root.findByType(quickCommandEditorForm)
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

  it('keeps creation closed when the host command limit is reached', async () => {
    mocks.commands = Array.from({ length: MAX_QUICK_COMMANDS }, (_, index) => ({
      ...command,
      id: `command-${index}`
    }))
    await act(async () => {
      renderer = create(
        createElement(QuickCommandsSheet, {
          visible: true,
          onClose: vi.fn(),
          client: {} as RpcClient,
          repoId: 'repo-1',
          repoName: 'Repo',
          onLaunch: () => true
        })
      )
    })

    const list = renderer!.root.findByType(quickCommandsList)
    expect(list.props.canAdd).toBe(false)
    act(() => list.props.onAdd())
    expect(renderer!.root.findAllByType(quickCommandEditorForm)).toHaveLength(0)
  })

  it('shows only global commands and defaults new commands to global without a repo', async () => {
    const repoCommand: TerminalQuickCommand = {
      ...command,
      id: 'repo-command',
      scope: { type: 'repo', repoId: 'repo-1' }
    }
    mocks.commands = [command, repoCommand]
    await act(async () => {
      renderer = create(
        createElement(QuickCommandsSheet, {
          visible: true,
          onClose: vi.fn(),
          client: {} as RpcClient,
          repoId: null,
          repoName: 'Folder workspace',
          onLaunch: () => true
        })
      )
    })

    const list = renderer!.root.findByType(quickCommandsList)
    expect(list.props.globalCommands).toEqual([command])
    expect(list.props.repoCommands).toEqual([])
    act(() => list.props.onAdd())
    expect(renderer!.root.findByType(quickCommandEditorForm).props.draft.scope).toEqual({
      type: 'global'
    })
  })

  it('does not delete a shared command until the destructive action is confirmed', async () => {
    await act(async () => {
      renderer = create(
        createElement(QuickCommandsSheet, {
          visible: true,
          onClose: vi.fn(),
          client: {} as RpcClient,
          repoId: 'repo-1',
          repoName: 'Repo',
          onLaunch: () => true
        })
      )
    })

    act(() => renderer!.root.findByType(quickCommandsList).props.onDelete(command))
    expect(mocks.persist).not.toHaveBeenCalled()

    const actions = mocks.alert.mock.calls[0]?.[2] as
      | Array<{ style?: string; onPress?: () => void }>
      | undefined
    act(() => actions?.find((action) => action.style === 'destructive')?.onPress?.())

    expect(mocks.persist).toHaveBeenCalledTimes(1)
    expect(mocks.persist).toHaveBeenCalledWith({ type: 'delete', id: command.id })
  })
})
