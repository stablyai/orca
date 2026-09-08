import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getTrustedUIRendererWebContentsMock, handleMock } = vi.hoisted(() => ({
  getTrustedUIRendererWebContentsMock: vi.fn(),
  handleMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('./ui', () => ({
  getTrustedUIRendererWebContents: getTrustedUIRendererWebContentsMock
}))

import { handleMainWindowSkillIpc } from './skill-ipc-main-window'

describe('main-window skill IPC', () => {
  beforeEach(() => {
    handleMock.mockReset()
    getTrustedUIRendererWebContentsMock.mockReset()
  })

  it('allows the trusted main renderer', () => {
    const listener = vi.fn(() => 'ok')
    const sender = { id: 1 }
    getTrustedUIRendererWebContentsMock.mockReturnValue(sender)
    handleMainWindowSkillIpc('skills:test', listener)

    const handler = handleMock.mock.calls[0][1]
    expect(handler({ sender }, 'value')).toBe('ok')
    expect(listener).toHaveBeenCalledWith({ sender }, 'value')
  })

  it.each([
    ['dashboard pop-out', { id: 2 }],
    ['stale renderer', { id: 3 }],
    ['missing main window', { id: 4 }]
  ])('rejects the %s before invoking skill code', (_label, sender) => {
    const listener = vi.fn()
    getTrustedUIRendererWebContentsMock.mockReturnValue(null)
    handleMainWindowSkillIpc('skills:test', listener)

    const handler = handleMock.mock.calls[0][1]
    expect(() => handler({ sender }, 'value')).toThrow('Unauthorized skill IPC sender')
    expect(listener).not.toHaveBeenCalled()
  })
})
