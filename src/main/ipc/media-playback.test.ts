import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, getMediaPlaybackStatusMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  getMediaPlaybackStatusMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock }
}))

vi.mock('../media-playback/macos-media-playback-status', () => ({
  getMediaPlaybackStatus: getMediaPlaybackStatusMock
}))

import { registerMediaPlaybackHandlers } from './media-playback'

describe('registerMediaPlaybackHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    getMediaPlaybackStatusMock.mockReset()
  })

  it('registers the read-only playback status bridge', async () => {
    const status = {
      player: 'spotify',
      state: 'playing',
      artist: 'AtHeart',
      track: 'Say It'
    }
    getMediaPlaybackStatusMock.mockResolvedValue(status)

    registerMediaPlaybackHandlers()

    const registration = handleMock.mock.calls.find(
      ([channel]) => channel === 'mediaPlayback:getStatus'
    )
    expect(registration).toBeTruthy()
    await expect(registration![1]()).resolves.toBe(status)
  })
})
