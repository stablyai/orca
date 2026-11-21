import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

const page = vi.hoisted((): { current: unknown } => ({ current: null }))
const handlers = vi.hoisted(() => new Map<string, (event: { sender: unknown }) => unknown>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: { sender: unknown }) => unknown) =>
      handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel)
  }
}))
vi.mock('../ui', () => ({ getTrustedUIRendererWebContents: () => page.current }))

import {
  playDeliveredSound,
  registerNotificationSoundHandlers,
  retireDeliveredSound
} from './notification-sound-ipc'
import type { Store } from '../../persistence/loading-store/store'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sound path reads only getSettings().notifications.
const store = {
  getSettings: () => ({ notifications: { customSoundId: 'ding', customSoundVolume: 80 } })
} as unknown as Store
registerNotificationSoundHandlers(store)

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
const claim = (contents: unknown): unknown =>
  handlers.get('notifications:claimDeliveredSound')?.({ sender: contents })

function deliver(alerts: number): void {
  for (let alert = 0; alert < alerts; alert++) {
    playDeliveredSound(store, `alert-${alert}`)
  }
}

function retire(from: number, alerts: number): void {
  for (let alert = from; alert < alerts; alert++) {
    retireDeliveredSound(`alert-${alert}`)
  }
}

it('cleared alerts never sound, wherever their sound was waiting', async () => {
  for (const alerts of [100, 1_000]) {
    const loading = renderer(true)
    deliver(alerts)
    expect(loading.listenerCount('did-finish-load')).toBe(1)
    retire(0, alerts)
    loading.emit('did-finish-load')
    expect(loading.send).not.toHaveBeenCalled()

    const ready = renderer(false)
    deliver(alerts)
    retire(0, alerts)
    await nextTurn()
    expect(ready.send).not.toHaveBeenCalled()

    const playing = renderer(false)
    deliver(alerts)
    await nextTurn()
    expect(playing.send).toHaveBeenCalledTimes(1)
    retire(0, alerts)
    expect(claim(playing)).toBe(false)
  }
})

it('a burst with one alert still showing sounds once', async () => {
  for (const alerts of [100, 1_000]) {
    const ready = renderer(false)
    deliver(alerts)
    retire(1, alerts)
    await nextTurn()
    expect(ready.send).toHaveBeenCalledTimes(1)
    expect(claim(ready)).toBe(true)
    expect(claim(ready)).toBe(false)
  }
})
