import { createElement, useEffect } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, expect, it, vi } from 'vitest'
import { useShellPageStorageRefresh } from './use-shell-page-storage-refresh'

import {
  hydrateMirroredStorage,
  readMirroredStorage,
  retainMirroredStorage,
  writeMirroredStorage
} from '../../storage/mirrored-storage-keys'

import { createFakeBridgePortPair } from '../bridge/test-support/bridge-port-pair-test-harness'

const store = vi.hoisted(() => ({
  values: new Map<string, string>(),
  pending: new Array<() => void>()
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    setItem: (key: string, value: string) =>
      new Promise<void>((resolve) =>
        store.pending.push(() => {
          store.values.set(key, value)
          resolve()
        })
      ),
    getItem: async (key: string) => store.values.get(key) ?? null,
    multiGet: async (keys: string[]) => keys.map((key) => [key, store.values.get(key) ?? null])
  }
}))
const focus = vi.hoisted(() => ({ active: true }))
const app = vi.hoisted(() => ({ listener: (_state: string) => {}, remove: vi.fn() }))
vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) =>
    useEffect(() => (focus.active ? effect() : undefined), [effect, focus.active])
}))
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      app.listener = listener
      return { remove: app.remove }
    }
  }
}))

beforeEach(() => {
  focus.active = true
  app.remove.mockClear()
  store.values.clear()
  store.pending.length = 0
})

it('republishes an accepted page zoom after an older native snapshot crosses the pinch', async () => {
  const key = 'orca:terminalTextScale'
  store.values.set(key, '1')
  const releaseKeys = retainMirroredStorage([key])
  const storage = { [key]: '1' }
  let hold = false
  const held: string[] = []
  const pair = createFakeBridgePortPair({
    route: { pathname: '/h/host-a/session/wt-1' },
    storage,
    holdToPage: (json) => {
      if (hold) {
        held.push(json)
      }
      return hold
    },
    onStorageWrite: writeMirroredStorage
  })
  await pair.flush()
  let displayedScale = 1
  pair.client.onStorageUpdate(() => {
    displayedScale = Number(pair.client.getShellSession()!.storage[key])
  })
  const refresh = () => hydrateMirroredStorage([key])
  const publish = () => {
    Object.assign(storage, readMirroredStorage([key]))
    pair.host.publishStorage()
  }
  function Harness() {
    useShellPageStorageRefresh(refresh, publish)
    return null
  }
  let renderer!: ReturnType<typeof create>
  await act(async () => {
    renderer = create(createElement(Harness))
    await pair.flush()
  })
  hold = true
  pair.host.publishStorage()
  displayedScale = 1.5
  expect(pair.client.notifyStorageWrite(key, '1.5')).toBe(true)
  await act(async () => pair.flush())
  pair.deliverToPage(held.shift()!)
  expect(displayedScale).toBe(1)
  for (const frame of held) {
    pair.deliverToPage(frame)
  }
  await act(async () => store.pending.shift()!())
  expect(store.values.get(key)).toBe('1.5')
  expect(displayedScale).toBe(1.5)
  act(() => renderer.unmount())
  pair.client.close()
  pair.host.dispose()
  releaseKeys()
})
