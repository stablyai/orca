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
const linux = { platform: 'linux' as const, hostEnv: HOST, hostHome: () => '/home/u' }

afterEach(() => {
  vi.restoreAllMocks()
})

it("reads the host's own login only from the host's home, file-or-keyring store and session bus", async () => {
  expect(await agyLaunchIsForeign({ ...HOST }, linux)).toBe(false)
  // The same bus, whatever server guid or spelling names it.
  expect(
    await agyLaunchIsForeign(
      { ...HOST, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
      linux
    )
  ).toBe(false)
  expect(await agyLaunchIsForeign({ ...HOST, DBUS_SESSION_BUS_ADDRESS: 'disabled:' }, linux)).toBe(
    false
  )

  expect(await agyLaunchIsForeign({ ...HOST, HOME: '/home/other' }, linux)).toBe(true)
  expect(await agyLaunchIsForeign({ ...HOST }, { ...linux, envToDelete: ['HOME'] })).toBe(true)
  // Another Secret Service holds another login.
  expect(
    await agyLaunchIsForeign(
      { ...HOST, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/dbus-other,guid=bbbb' },
      linux
    )
  ).toBe(true)
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
