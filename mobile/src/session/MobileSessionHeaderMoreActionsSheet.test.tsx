import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileSessionHeaderMoreActionsSheet } from './MobileSessionHeaderMoreActionsSheet'

const state = vi.hoisted(() => ({
  save: vi.fn<() => Promise<void>>(),
  load: vi.fn(() => Promise.resolve('system')),
  alert: vi.fn()
}))
vi.mock('react-native', () => ({ Alert: { alert: state.alert } }))
vi.mock('lucide-react-native', () => ({ ListChecks: 'ListChecks', Palette: 'Palette' }))
vi.mock('../agent-history/MobileAgentSessionHistoryIcon', () => ({
  MobileAgentSessionHistoryIcon: 'MobileAgentSessionHistoryIcon'
}))
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('../components/PickerModal', () => ({ PickerModal: 'PickerModal' }))
vi.mock('../storage/terminal-theme-preference', () => ({
  getMobileTerminalThemeMode: () => 'system',
  subscribeMobileTerminalThemeMode: () => () => {},
  loadMobileTerminalThemeMode: state.load,
  saveMobileTerminalThemeMode: state.save
}))

let renderer: ReactTestRenderer
afterEach(() => {
  act(() => renderer?.unmount())
  vi.clearAllMocks()
})

async function openAppearancePicker() {
  await act(async () => {
    renderer = create(
      createElement(MobileSessionHeaderMoreActionsSheet, {
        visible: true,
        showAgentSessionHistory: false,
        showChecks: false,
        onOpenAgentSessionHistory: vi.fn(),
        onOpenChecks: vi.fn(),
        onClose: vi.fn()
      })
    )
  })
  const action = renderer.root.findByType('ActionSheetModal').props.actions[0]
  expect(action).toMatchObject({ label: 'Terminal appearance', closeBeforePress: true })
  act(() => action.onPress())
  return renderer.root.findByType('PickerModal')
}

describe('mobile terminal appearance menu', () => {
  it('offers phone automatic by default even without host actions and saves the selection', async () => {
    state.save.mockResolvedValueOnce()
    const picker = await openAppearancePicker()
    expect(picker.props.visible).toBe(true)
    expect(picker.props.selected).toBe('system')
    expect(picker.props.options.map((option: { value: string }) => option.value)).toEqual([
      'system',
      'dark',
      'light',
      'desktop'
    ])
    await act(async () => picker.props.onSelect('dark'))
    expect(state.save).toHaveBeenCalledWith('dark')
  })

  it('reports a failed save instead of claiming the choice was persisted', async () => {
    state.save.mockRejectedValueOnce(new Error('storage unavailable'))
    const picker = await openAppearancePicker()
    await act(async () => picker.props.onSelect('light'))
    expect(state.alert).toHaveBeenCalledWith(
      'Terminal appearance',
      expect.stringContaining('Couldn’t save')
    )
  })
})
