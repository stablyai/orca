import { afterEach, expect, it, vi } from 'vitest'
import { setAppEnvironment, type AppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { agyLaunchIsForeign } from './agy-launch-credential-authority'
import { AGY_HOST_SELECTION } from './agy-account-selection'
import { restoreSelectedAntigravityAccount } from './native-account-launch'

const HOST = {
  HOME: '/home/u',
  XDG_RUNTIME_DIR: '/run/user/1000',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus,guid=aaaa'
}
// A keyring host, where `/home/me` links to `/home/u`; no other path's real path reads.
const linux = {
  platform: 'linux' as const,
  hostEnv: HOST,
  hostHome: () => '/home/u',
  usesFileStore: async () => false,
  realpath: async (path: string) => {
    if (path === '/home/me' || path === '/home/u') {
      return '/home/u'
    }
    throw new Error('ENOENT')
  }
}
const withBus = (address: string) => ({ ...HOST, DBUS_SESSION_BUS_ADDRESS: address })

afterEach(() => {
  vi.restoreAllMocks()
})

it('reads a launch on the same session bus, however its address is spelled, as the host login', async () => {
  for (const address of [
    'unix:path=/run/user/1000/bus',
    'unix:guid=bbbb,path=/run/user/1000/bus',
    'unix:path=/run/user/1000//bus/',
    'unix:path=%2Frun%2Fuser%2F1000%2Fbus',
    'disabled:'
  ]) {
    expect(await agyLaunchIsForeign(withBus(address), linux)).toBe(false)
  }
  // The runtime folder's bus, with or without a trailing slash, is the explicit socket.
  expect(
    await agyLaunchIsForeign(
      { HOME: '/home/u', XDG_RUNTIME_DIR: '/run/user/1000/' },
      { ...linux, hostEnv: withBus('unix:path=/run/user/1000/bus') }
    )
  ).toBe(false)
  // An address this can't read never turns switching off.
  expect(await agyLaunchIsForeign(withBus('not-an-address'), linux)).toBe(false)
})

it('reads a launch on another session bus, or another fallback order, as another login', async () => {
  expect(await agyLaunchIsForeign(withBus('unix:path=/tmp/dbus-other,guid=bbbb'), linux)).toBe(true)
  expect(
    await agyLaunchIsForeign(withBus('unix:path=/run/user/1000/bus;unix:path=/tmp/a'), {
      ...linux,
      hostEnv: withBus('unix:path=/run/user/1000/bus;unix:path=/tmp/b')
    })
  ).toBe(true)
})

it("compares buses only when both launches use the keyring, not agy's token file", async () => {
  const fileStore = { ...linux, usesFileStore: async () => true }
  expect(await agyLaunchIsForeign(withBus('unix:path=/tmp/dbus-other'), fileStore)).toBe(false)
  const launchOnly = {
    ...linux,
    usesFileStore: async (env: NodeJS.ProcessEnv) => env !== HOST
  }
  expect(await agyLaunchIsForeign({ ...HOST }, launchOnly)).toBe(true)
})

it('reads a home by what it is, not how it is spelled', async () => {
  expect(await agyLaunchIsForeign({ ...HOST, HOME: '/home/u/' }, linux)).toBe(false)
  expect(await agyLaunchIsForeign({ ...HOST, HOME: '/home/me' }, linux)).toBe(false)
  expect(
    await agyLaunchIsForeign(
      { USERPROFILE: 'c:\\users\\u' },
      {
        ...linux,
        platform: 'win32',
        hostHome: () => 'C:\\Users\\U'
      }
    )
  ).toBe(false)
  expect(
    await agyLaunchIsForeign(
      { ...HOST, HOME: '/Users/U' },
      {
        ...linux,
        platform: 'darwin',
        hostHome: () => '/Users/u'
      }
    )
  ).toBe(false)

  expect(await agyLaunchIsForeign({ ...HOST, HOME: '/home/other' }, linux)).toBe(true)
  expect(await agyLaunchIsForeign({ ...HOST, HOME: '/home/U' }, linux)).toBe(true)
  expect(await agyLaunchIsForeign({ ...HOST }, { ...linux, envToDelete: ['HOME'] })).toBe(true)
})

it('decides a launch is foreign before anything about saved accounts, even with none selected', async () => {
  const environment: AppEnvironment = {
    getPath: () => '/home/u',
    getAppPath: () => '/app',
    getVersion: () => '0.0.0',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  }
  setAppEnvironment(environment)
  const atLaunch = vi.spyOn(AGY_HOST_SELECTION, 'atLaunch')
  expect(await restoreSelectedAntigravityAccount({ HOME: '/home/other' })).toEqual({
    foreign: true
  })
  expect(atLaunch).not.toHaveBeenCalled()
})
