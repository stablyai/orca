// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type * as PluginPanels from '@/store/plugin-panels'
import { AI_VAULT_SCOPE_STEP_EVENT } from '@/components/right-sidebar/ai-vault-scope-state'
import type { KeybindingActionId } from '../../../shared/keybindings'
import { useGlobalKeybindings } from './use-global-keybindings'
import { useAppChromeLayout } from './use-app-chrome-layout'
import { useFloatingWorkspacePanel } from './use-floating-workspace-panel'

vi.mock('@/store/plugin-panels', async (importOriginal) => ({
  ...(await importOriginal<typeof PluginPanels>()),
  usePluginCommands: () => []
}))
vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: () => 'darwin' }))
vi.mock('./app-window-chrome', () => ({ shortcutPlatform: 'darwin' }))

const initial = useAppStore.getState()
const steps: number[] = []
const record = (event: Event): void => {
  if (event instanceof CustomEvent) {
    steps.push(event.detail)
  }
}

beforeEach(() => {
  vi.stubGlobal('reportError', (error: unknown) => {
    throw error
  })
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
  window.addEventListener(AI_VAULT_SCOPE_STEP_EVENT, record)
  useAppStore.setState({ activeView: 'terminal', activeWorktreeId: 'main', rightSidebarOpen: true })
})

afterEach(() => {
  cleanup()
  window.removeEventListener(AI_VAULT_SCOPE_STEP_EVENT, record)
  steps.length = 0
  document.body.replaceChildren()
  useAppStore.setState(initial, true)
  vi.unstubAllGlobals()
})

function pressInSearchField(
  actionId: KeybindingActionId,
  chord: string,
  init: KeyboardEventInit,
  inSidebarPanel = true
): KeyboardEvent {
  useAppStore.setState({ keybindings: { [actionId]: [chord] } })
  const host = document.createElement('div')
  if (inSidebarPanel) {
    host.dataset.aiVaultPanel = 'true'
  }
  const search = document.createElement('input')
  search.dataset.fileSearchInput = 'true'
  host.append(search)
  document.body.append(host)
  search.focus()
  renderHook(() =>
    useGlobalKeybindings({
      layout: useAppChromeLayout(),
      floatingWorkspace: useFloatingWorkspacePanel()
    })
  )
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'getModifierState', { value: () => false })
  search.dispatchEvent(event)
  return event
}

const ctrlPageDown = { key: 'PageDown', code: 'PageDown', ctrlKey: true }

it('runs a Ctrl scope chord from the sidebar Agents search field', () => {
  pressInSearchField('sidebar.agents.scopeNext', 'Ctrl+PageDown', ctrlPageDown)
  expect(steps).toEqual([1])
})

it('leaves the same chord with the field outside the sidebar Agents panel', () => {
  pressInSearchField('sidebar.agents.scopeNext', 'Ctrl+PageDown', ctrlPageDown, false)
  expect(steps).toEqual([])
})

it('runs a Ctrl Show Agents chord from the sidebar Agents search field and closes the sidebar', () => {
  pressInSearchField('sidebar.agents.toggle', 'Ctrl+PageDown', ctrlPageDown)
  expect(useAppStore.getState().rightSidebarOpen).toBe(false)
})

it('keeps an Option dead key with the search field even when it is bound', () => {
  const event = pressInSearchField('sidebar.agents.scopeNext', 'Alt+E', {
    key: 'Dead',
    code: 'KeyE',
    altKey: true
  })
  expect(steps).toEqual([])
  expect(event.defaultPrevented).toBe(false)
})
