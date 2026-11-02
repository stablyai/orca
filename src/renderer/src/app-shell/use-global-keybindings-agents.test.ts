// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type * as PluginPanels from '@/store/plugin-panels'
import { AI_VAULT_SCOPE_STEP_EVENT } from '@/components/right-sidebar/ai-vault-scope-state'
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
  useAppStore.setState({
    activeView: 'terminal',
    activeWorktreeId: 'main',
    keybindings: { 'sidebar.agents.scopeNext': ['Ctrl+PageDown'] }
  })
})

afterEach(() => {
  cleanup()
  window.removeEventListener(AI_VAULT_SCOPE_STEP_EVENT, record)
  steps.length = 0
  document.body.replaceChildren()
  useAppStore.setState(initial, true)
  vi.unstubAllGlobals()
})

function pressCtrlPageDownIn(searchHost: HTMLElement): void {
  const search = document.createElement('input')
  search.dataset.fileSearchInput = 'true'
  searchHost.append(search)
  document.body.append(searchHost)
  search.focus()
  renderHook(() =>
    useGlobalKeybindings({
      layout: useAppChromeLayout(),
      floatingWorkspace: useFloatingWorkspacePanel()
    })
  )
  const event = new KeyboardEvent('keydown', {
    key: 'PageDown',
    code: 'PageDown',
    ctrlKey: true,
    bubbles: true,
    cancelable: true
  })
  Object.defineProperty(event, 'getModifierState', { value: () => false })
  search.dispatchEvent(event)
}

it('runs a Ctrl scope chord from the sidebar Agents search field', () => {
  const panel = document.createElement('div')
  panel.dataset.aiVaultPanel = 'true'
  pressCtrlPageDownIn(panel)
  expect(steps).toEqual([1])
})

it('leaves the same chord with the field outside the sidebar Agents panel', () => {
  pressCtrlPageDownIn(document.createElement('div'))
  expect(steps).toEqual([])
})
