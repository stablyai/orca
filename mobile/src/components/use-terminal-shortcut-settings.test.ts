import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTerminalShortcutSettings } from './use-terminal-shortcut-settings'
import { getDefaultTerminalAccessoryLayout } from '../terminal/terminal-accessory-layout'
import type { TerminalShortcutPreferences } from '../terminal/terminal-settings-operations'
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }))
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }))
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return { useFocusEffect: (callback: () => void) => useEffect(callback, [callback]) }
})
let renderer: ReactTestRenderer | undefined
let state: ReturnType<typeof useTerminalShortcutSettings>
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
})
function preferences() {
  return {
    loadLayout: vi.fn().mockResolvedValue(getDefaultTerminalAccessoryLayout()),
    loadKeys: vi.fn().mockResolvedValue([]),
    saveLayout: vi.fn().mockResolvedValue(undefined),
    saveKeys: vi.fn().mockResolvedValue(undefined)
  }
}
async function mount(storage: TerminalShortcutPreferences) {
  function Harness() {
    state = useTerminalShortcutSettings(storage)
    return null
  }
  await act(async () => {
    renderer = create(createElement(Harness))
  })
}
describe('terminal shortcut settings persistence', () => {
  it('writes layout changes to the injected page or native preference owner', async () => {
    const storage = preferences()
    await mount(storage)
    expect(state.busy).toBe(false)
    await act(async () => {
      state.toggleBuiltInKey('escape', false)
    })
    expect(storage.saveLayout).toHaveBeenCalledTimes(1)
    expect(storage.saveLayout.mock.calls[0]?.[0].visibleBuiltInIds).not.toContain('escape')
    expect(state.visibleBuiltInSet.has('escape')).toBe(false)
    expect(state.busy).toBe(false)
  })
  it('restores the last saved layout and reports failed persistence', async () => {
    const storage = preferences()
    storage.saveLayout.mockRejectedValue(new Error('storage failed'))
    await mount(storage)
    await act(async () => {
      state.toggleBuiltInKey('escape', false)
    })
    expect(state.visibleBuiltInSet.has('escape')).toBe(true)
    expect(state.error).toContain('Could not save shortcut layout')
    expect(storage.saveLayout).toHaveBeenCalledTimes(1)
  })
  it('never enables controls over unreadable initial data', async () => {
    const storage = preferences()
    storage.loadKeys.mockRejectedValue(new Error('storage failed'))
    await mount(storage)
    expect(state.busy).toBe(true)
    expect(state.error).toContain('Could not load custom shortcuts')
  })
})
