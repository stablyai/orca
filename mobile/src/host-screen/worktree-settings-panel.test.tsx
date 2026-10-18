import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))

import type { Worktree } from '../worktree/workspace-list-types'
import type { WorktreeRenameOutcome } from './use-host-worktree-rename'
import { WorktreeSettingsPanel } from './worktree-settings-panel'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the panel reads only the name, branch, path and repo.
const TARGET = {
  worktreeId: 'wt',
  repo: 'orca',
  branch: 'refs/heads/feat/login',
  path: '/w/login',
  displayName: 'Login work'
} as Worktree

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

function mount(onSave: (draft: string) => Promise<WorktreeRenameOutcome>, onCancel = vi.fn()) {
  act(() => {
    renderer = create(createElement(WorktreeSettingsPanel, { target: TARGET, onCancel, onSave }))
  })
  const root = renderer!.root
  return {
    input: () => root.find((node) => String(node.type) === 'TextInput'),
    texts: () =>
      root
        .findAll((node) => String(node.type) === 'Text')
        .flatMap((node) => node.props.children)
        .filter((child): child is string => typeof child === 'string'),
    button: (label: string) =>
      root.find(
        (node) =>
          String(node.type) === 'Pressable' &&
          node.findAll((child) => child.props.children === label).length > 0
      ),
    onCancel
  }
}

describe('Worktree Settings', () => {
  it('opens on the name the sidebar shows, with the branch as the automatic name', () => {
    const panel = mount(vi.fn())
    expect(panel.texts()).toEqual(
      expect.arrayContaining(['Worktree Settings', 'feat/login', 'Display Name'])
    )
    expect(panel.input().props.value).toBe('Login work')
    expect(panel.input().props.placeholder).toBe('feat/login')
  })

  it('saves the edited text and holds the form while the host answers', async () => {
    let answer: (outcome: WorktreeRenameOutcome) => void = () => {}
    const onSave = vi.fn(
      () =>
        new Promise<WorktreeRenameOutcome>((resolve) => {
          answer = resolve
        })
    )
    const panel = mount(onSave)
    act(() => panel.input().props.onChangeText('Login v2'))
    act(() => panel.button('Save').props.onPress())
    expect(onSave).toHaveBeenCalledWith('Login v2')
    expect(panel.input().props.editable).toBe(false)
    expect(panel.texts()).toContain('Saving...')
    act(() => panel.button('Saving...').props.onPress())
    expect(onSave).toHaveBeenCalledTimes(1)
    await act(async () => answer({ ok: true }))
  })

  it("shows the host's refusal and lets the user try again", async () => {
    const onSave = vi.fn(async () => ({ ok: false, error: 'Worktree not found' }) as const)
    const panel = mount(onSave)
    await act(async () => panel.input().props.onSubmitEditing())
    expect(panel.texts()).toContain('Worktree not found')
    expect(panel.input().props.editable).toBe(true)
    expect(panel.texts()).toContain('Save')
  })

  it('cancels without saving', () => {
    const onSave = vi.fn()
    const panel = mount(onSave)
    act(() => panel.button('Cancel').props.onPress())
    expect(panel.onCancel).toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })
})
