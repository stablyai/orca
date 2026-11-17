import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'

const device = vi.hoisted(() => ({
  events: new Map<string, (state: string) => void>(),
  tags: [] as string[],
  platform: { OS: 'android' },
  resolveStored: undefined as undefined | ((value: string | null) => void)
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: () =>
      new Promise<string | null>((resolve) => {
        device.resolveStored = resolve
      }),
    setItem: async () => {}
  }
}))
vi.mock('react-native', () => ({
  Platform: device.platform,
  AppState: {
    currentState: 'active',
    addEventListener: (event: string, callback: (state: string) => void) => {
      device.events.set(event, callback)
      return { remove: () => device.events.delete(event) }
    }
  }
}))
vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: async (tag: string) => {
    device.tags.push(`+${tag}`)
  },
  deactivateKeepAwake: async (tag: string) => {
    device.tags.push(`-${tag}`)
  }
}))
import { setScreenAwakePreference, useScreenAwake } from './mobile-screen-awake'

it('holds only while opted in and foreground, and releases on blur or unmount', async () => {
  function Probe() {
    useScreenAwake()
    return null
  }
  let root: ReturnType<typeof create>
  await act(async () => {
    root = create(<Probe />)
  })
  expect(device.tags).toEqual([])
  await act(async () => {
    device.events.get('blur')?.('')
    device.resolveStored?.('true')
  })
  expect(device.tags).toEqual([])
  await act(async () => {
    device.events.get('focus')?.('')
  })
  expect(device.tags).toEqual(['+orca-screen-awake'])
  await act(async () => {
    device.events.get('blur')?.('')
  })
  expect(device.tags).toEqual(['+orca-screen-awake', '-orca-screen-awake'])
  await act(async () => {
    await setScreenAwakePreference(false)
  })
  await act(async () => {
    await setScreenAwakePreference(true)
  })
  expect(device.tags).toEqual(['+orca-screen-awake', '-orca-screen-awake'])
  await act(async () => {
    device.events.get('focus')?.('')
  })
  await act(async () => {
    device.events.get('change')?.('background')
  })
  expect(device.tags).toEqual([
    '+orca-screen-awake',
    '-orca-screen-awake',
    '+orca-screen-awake',
    '-orca-screen-awake'
  ])
  await act(async () => {
    device.events.get('change')?.('active')
  })
  await act(async () => {
    root!.unmount()
  })
  expect(device.tags.slice(-2)).toEqual(['+orca-screen-awake', '-orca-screen-awake'])
})

it('subscribes only to supported app state events on iOS', async () => {
  device.platform.OS = 'ios'
  function Probe() {
    useScreenAwake()
    return null
  }
  let root: ReturnType<typeof create>
  await act(async () => {
    root = create(<Probe />)
  })
  expect([...device.events.keys()]).toEqual(['change'])
  await act(async () => {
    root!.unmount()
  })
})
