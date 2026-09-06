import { describe, expect, it, vi } from 'vitest'
import { TerminalSettingsModalHandoff } from './terminal-settings-modal-handoff'

describe('Terminal Settings shortcut-modal handoff', () => {
  it('waits for the drawer close completion before native navigation', () => {
    const calls: string[] = []
    const openSettings = vi.fn(() => calls.push('open'))
    const handoff = new TerminalSettingsModalHandoff()

    handoff.request(() => calls.push('close'))

    expect(calls).toEqual(['close'])
    expect(openSettings).not.toHaveBeenCalled()
    expect(handoff.complete(openSettings)).toBe(true)
    expect(calls).toEqual(['close', 'open'])
    expect(handoff.complete(openSettings)).toBe(false)
    expect(openSettings).toHaveBeenCalledTimes(1)
  })
})
