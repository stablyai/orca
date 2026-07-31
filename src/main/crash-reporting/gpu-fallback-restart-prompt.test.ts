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
      buttons: ['Restart in Safe Graphics Mode', 'Keep Running'],
      defaultId: 0,
      cancelId: 1,
      title: 'Restart Orca in Safe Graphics Mode?',
      message: "Orca's graphics process has crashed repeatedly.",
      detail:
        'Safe graphics mode disables hardware acceleration and WebGL for this Orca version. Terminals and 3D content may render more slowly. Keep Running leaves graphics settings unchanged.'
    })
  })

  it('treats the secondary or dismissed response as continue', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 1 })

    await expect(promptForGpuFallbackRestart()).resolves.toBe('continue')
    expect(showMessageBoxMock).toHaveBeenCalledOnce()
  })
})
