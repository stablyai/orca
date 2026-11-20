import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

const page = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))
vi.mock('../ui', () => ({ getTrustedUIRendererWebContents: () => page.current }))

import { playDeliveredSound, retireDeliveredSound } from './notification-sound-ipc'
import type { Store } from '../../persistence/loading-store/store'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sound path reads only getSettings().notifications.
const store = {
  getSettings: () => ({ notifications: { customSoundId: 'ding', customSoundVolume: 80 } })
} as unknown as Store

function renderer(loading: boolean) {
  const contents = Object.assign(new EventEmitter(), {
    isLoading: () => loading,
    isDestroyed: () => false,
    send: vi.fn()
  })
  page.current = contents
  return contents
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

it('alerts delivered while the page loads hold one listener and sound once only for one still showing', async () => {
  for (const alerts of [100, 1_000]) {
    const cleared = renderer(true)
    for (let alert = 0; alert < alerts; alert++) {
      playDeliveredSound(store, `alert-${alert}`)
    }
    for (let alert = 0; alert < alerts; alert++) {
      retireDeliveredSound(`alert-${alert}`)
    }
    expect(cleared.listenerCount('did-finish-load')).toBe(1)
    cleared.emit('did-finish-load')
    await nextTurn()
    expect(cleared.send).not.toHaveBeenCalled()

    const live = renderer(true)
    for (let alert = 0; alert < alerts; alert++) {
      playDeliveredSound(store, `alert-${alert}`)
    }
    for (let alert = 1; alert < alerts; alert++) {
      retireDeliveredSound(`alert-${alert}`)
    }
    live.emit('did-finish-load')
    await nextTurn()
    expect(live.send).toHaveBeenCalledTimes(1)
  }
})

it('a burst of alerts on a ready page asks the page for one sound', async () => {
  for (const alerts of [100, 1_000]) {
    const ready = renderer(false)
    for (let alert = 0; alert < alerts; alert++) {
      playDeliveredSound(store, `alert-${alert}`)
    }
    await nextTurn()
    expect(ready.send).toHaveBeenCalledTimes(1)
  }
})
