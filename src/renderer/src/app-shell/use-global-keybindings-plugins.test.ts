// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useGlobalKeybindings } from './use-global-keybindings'
import { useAppChromeLayout } from './use-app-chrome-layout'
import { useFloatingWorkspacePanel } from './use-floating-workspace-panel'
import { replayAppKeyDown } from '@/lib/app-keyboard-router'

vi.mock('@/store/plugin-panels', () => ({ usePluginCommands: () => [] }))
vi.mock('@/app-shell/app-window-chrome', () => ({ shortcutPlatform: 'darwin' }))
vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: () => 'darwin' }))

const initial = useAppStore.getState()
const openSettingsPage = vi.fn()
const openSettingsTarget = vi.fn()

beforeEach(() => {
  useAppStore.setState({
    keybindings: { 'view.plugins': ['Alt+E'] },
    openSettingsPage,
    openSettingsTarget
  })
  renderHook(() =>
    useGlobalKeybindings({
      layout: useAppChromeLayout(),
      floatingWorkspace: useFloatingWorkspacePanel()
    })
  )
})
afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
})

function press(target: HTMLElement, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {
    key: 'e',
    code: 'KeyE',
    altKey: true,
    bubbles: true,
    cancelable: true,
    ...init
  })
  act(() => target.dispatchEvent(event))
  return event
}

it('opens Plugins from app focus but preserves textarea editing for the same configured chord', () => {
  const textarea = document.createElement('textarea')
  document.body.append(textarea)
  for (const target of [document.body, textarea]) {
    for (const init of [{ key: 'Dead' }, { key: 'Process' }, { isComposing: true }]) {
      expect(press(target, init).defaultPrevented).toBe(false)
      expect(openSettingsPage).not.toHaveBeenCalled()
    }
  }
  expect(press(textarea).defaultPrevented).toBe(false)
  expect(openSettingsPage).not.toHaveBeenCalled()
  expect(press(document.body).defaultPrevented).toBe(true)
  expect(openSettingsPage).toHaveBeenCalledOnce()
  expect(openSettingsTarget).toHaveBeenCalledWith({
    pane: 'plugins',
    repoId: null,
    intent: undefined
  })
})

it('preserves recorder, already-claimed input and repeat protections', () => {
  const recorder = document.createElement('button')
  recorder.dataset.shortcutRecorderActive = ''
  document.body.append(recorder)
  expect(press(recorder).defaultPrevented).toBe(false)
  expect(press(document.body, { repeat: true }).defaultPrevented).toBe(false)
  const claimed = new KeyboardEvent('keydown', {
    key: 'e',
    code: 'KeyE',
    altKey: true,
    cancelable: true
  })
  claimed.preventDefault()
  act(() => replayAppKeyDown(claimed))
  expect(openSettingsPage).not.toHaveBeenCalled()
})

it('dispatches guest replay chords and double taps through the real Plugins handler', () => {
  const chord = new KeyboardEvent('keydown', {
    key: 'e',
    code: 'KeyE',
    altKey: true,
    cancelable: true
  })
  act(() => replayAppKeyDown(chord))
  expect(chord.defaultPrevented).toBe(true)
  expect(openSettingsPage).toHaveBeenCalledOnce()
  act(() => useAppStore.setState({ keybindings: { 'view.plugins': ['DoubleTap+Shift'] } }))
  const gesture = Object.assign(new KeyboardEvent('keydown', { cancelable: true }), {
    doubleTapModifier: 'Shift'
  })
  act(() => replayAppKeyDown(gesture))
  expect(gesture.defaultPrevented).toBe(true)
  expect(openSettingsPage).toHaveBeenCalledTimes(2)
})
