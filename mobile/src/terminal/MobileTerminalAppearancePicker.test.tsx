import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PickerModal } from '../components/PickerModal'
import { MobileTerminalAppearancePicker } from './MobileTerminalAppearancePicker'

const state = vi.hoisted(() => ({
  save: vi.fn<() => Promise<void>>(),
  load: vi.fn(() => Promise.resolve('system')),
  alert: vi.fn()
}))
vi.mock('react-native', () => ({ Alert: { alert: state.alert } }))
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
      createElement(MobileTerminalAppearancePicker, {
        visible: true,
        onClose: vi.fn()
      })
    )
  })
  return renderer.root.findByType(PickerModal)
}

describe('mobile terminal appearance menu', () => {
  it('offers phone automatic by default and saves the selection', async () => {
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
