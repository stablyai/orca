import { beforeEach, describe, expect, it, vi } from 'vitest'

const { showMessageBoxMock } = vi.hoisted(() => ({
  showMessageBoxMock: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: { showMessageBox: showMessageBoxMock }
}))

import { promptForGpuFallbackRestart } from './gpu-fallback-restart-prompt'

beforeEach(() => {
  showMessageBoxMock.mockReset()
})

describe('promptForGpuFallbackRestart', () => {
  it('offers a restart without forcing it', async () => {
    const parentWindow = { id: 1 }
    showMessageBoxMock.mockResolvedValue({ response: 0 })

    await expect(promptForGpuFallbackRestart(parentWindow as never)).resolves.toBe('restart')
    expect(showMessageBoxMock).toHaveBeenCalledWith(parentWindow, {
      type: 'warning',
      buttons: ['Restart with Software Rendering', 'Keep Running'],
      defaultId: 0,
      cancelId: 1,
      title: 'Restart Orca?',
      message: "Orca's graphics process has crashed repeatedly.",
      detail:
        'Restart to switch to software rendering and reduce the chance of the app window crashing. If you keep running, Orca may become unstable.'
    })
  })

  it('treats the secondary or dismissed response as continue', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 1 })

    await expect(promptForGpuFallbackRestart()).resolves.toBe('continue')
    expect(showMessageBoxMock).toHaveBeenCalledOnce()
  })
})
