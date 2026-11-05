import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { Alert } from 'react-native'
import { useTerminalSplitLayout } from './use-terminal-split-layout'
import { loadTerminalSplitLayout, saveTerminalSplitLayout } from '../storage/preferences'

vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }))
vi.mock('../storage/preferences', () => ({
  loadTerminalSplitLayout: vi.fn(),
  saveTerminalSplitLayout: vi.fn().mockResolvedValue(undefined)
}))

it('keeps a user choice made before storage hydration and reports failed persistence', async () => {
  let resolveRead!: (layout: 'stacked') => void
  vi.mocked(loadTerminalSplitLayout).mockReturnValue(
    new Promise((resolve) => {
      resolveRead = resolve
    })
  )
  let preference!: ReturnType<typeof useTerminalSplitLayout>
  function Harness() {
    preference = useTerminalSplitLayout()
    return null
  }
  let tree!: ReturnType<typeof create>
  act(() => {
    tree = create(createElement(Harness))
  })
  try {
    expect(preference.terminalSplitLayout).toBe('auto')
    await act(async () => preference.setTerminalSplitLayout('side-by-side'))
    await act(async () => resolveRead('stacked'))
    expect(preference.terminalSplitLayout).toBe('side-by-side')
    vi.mocked(saveTerminalSplitLayout).mockRejectedValueOnce(new Error('storage unavailable'))
    await act(async () => preference.setTerminalSplitLayout('stacked'))
    expect(preference.terminalSplitLayout).toBe('stacked')
    expect(Alert.alert).toHaveBeenCalledWith(
      'Layout could not be saved',
      expect.stringContaining('retry')
    )
  } finally {
    act(() => tree.unmount())
  }
})
