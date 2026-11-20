import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

const page = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))
vi.mock('../ui', () => ({ getTrustedUIRendererWebContents: () => page.current }))

import { playDeliveredSound } from './notification-sound-ipc'
import type { Store } from '../../persistence/loading-store/store'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: playDeliveredSound reads only getSettings().notifications.
const store = {
  getSettings: () => ({ notifications: { customSoundId: 'ding', customSoundVolume: 80 } })
} as unknown as Store

function loadingPage() {
  const renderer = Object.assign(new EventEmitter(), { isLoading: () => true, send: vi.fn() })
  page.current = renderer
  return renderer
}

it('alerts delivered and cleared while the page loads hold one listener and replay no sound', () => {
  for (const alerts of [100, 1_000]) {
    const renderer = loadingPage()
    for (let alert = 0; alert < alerts; alert++) {
      playDeliveredSound(store, () => false)
    }
    expect(renderer.listenerCount('did-finish-load')).toBe(1)
    renderer.emit('did-finish-load')
    expect(renderer.send).not.toHaveBeenCalled()

    const next = loadingPage()
    for (let alert = 0; alert < alerts; alert++) {
      playDeliveredSound(store, () => alert === 0)
    }
    next.emit('did-finish-load')
    expect(next.send).toHaveBeenCalledTimes(1)
  }
})
