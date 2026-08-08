import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openExternalMock, showMessageBoxMock } = vi.hoisted(() => ({
  openExternalMock: vi.fn(),
  showMessageBoxMock: vi.fn()
}))

vi.mock('electron', () => ({
  shell: { openExternal: openExternalMock },
  dialog: { showMessageBox: showMessageBoxMock }
}))

import { openExternalAppUrlWithUserApproval } from './external-app-url-open'

describe('openExternalAppUrlWithUserApproval', () => {
  beforeEach(() => {
    openExternalMock.mockReset()
    showMessageBoxMock.mockReset()
    openExternalMock.mockResolvedValue(undefined)
  })

  it('opens http without prompting', async () => {
    await expect(openExternalAppUrlWithUserApproval('https://example.com/')).resolves.toBe('opened')
    expect(showMessageBoxMock).not.toHaveBeenCalled()
    expect(openExternalMock).toHaveBeenCalledWith('https://example.com/')
  })

  it('prompts for custom schemes and cancels by default path', async () => {
    showMessageBoxMock.mockResolvedValueOnce({ response: 1 })
    await expect(
      openExternalAppUrlWithUserApproval('oktaverify://bind', {
        requestingOrigin: 'https://login.example.com'
      })
    ).resolves.toBe('cancelled')
    expect(showMessageBoxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.stringContaining('oktaverify://bind'),
        message: expect.stringContaining('oktaverify')
      })
    )
    expect(showMessageBoxMock.mock.calls[0]?.[0]?.detail).toContain(
      'Requested by: https://login.example.com'
    )
    expect(openExternalMock).not.toHaveBeenCalled()
  })

  it('opens custom schemes after confirm', async () => {
    showMessageBoxMock.mockResolvedValueOnce({ response: 0 })
    await expect(openExternalAppUrlWithUserApproval('oktaverify://bind')).resolves.toBe('opened')
    expect(openExternalMock).toHaveBeenCalledWith('oktaverify://bind')
  })

  it('denies dangerous schemes', async () => {
    await expect(openExternalAppUrlWithUserApproval('javascript:alert(1)')).resolves.toBe('denied')
    expect(showMessageBoxMock).not.toHaveBeenCalled()
    expect(openExternalMock).not.toHaveBeenCalled()
  })
})
