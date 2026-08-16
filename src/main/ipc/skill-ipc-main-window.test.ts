import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, isTrustedUIRendererMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  isTrustedUIRendererMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('./ui', () => ({ isTrustedUIRenderer: isTrustedUIRendererMock }))

import { handleMainWindowSkillIpc } from './skill-ipc-main-window'

describe('main-window skill IPC', () => {
  beforeEach(() => {
    handleMock.mockReset()
    isTrustedUIRendererMock.mockReset()
  })

  it('allows the trusted main renderer', () => {
    const listener = vi.fn(() => 'ok')
    const sender = { id: 1 }
    isTrustedUIRendererMock.mockImplementation((candidate) => candidate === sender)
    handleMainWindowSkillIpc('skills:test', listener)

    const handler = handleMock.mock.calls[0][1]
    expect(handler({ sender }, 'value')).toBe('ok')
    expect(listener).toHaveBeenCalledWith({ sender }, 'value')
  })

  it.each([
    ['dashboard pop-out', { id: 2 }],
    ['stale renderer', { id: 3 }]
  ])('rejects the %s before invoking skill code', (_label, sender) => {
    const listener = vi.fn()
    isTrustedUIRendererMock.mockReturnValue(false)
    handleMainWindowSkillIpc('skills:test', listener)

    const handler = handleMock.mock.calls[0][1]
    expect(() => handler({ sender }, 'value')).toThrow('Unauthorized skill IPC sender')
    expect(listener).not.toHaveBeenCalled()
  })
})
