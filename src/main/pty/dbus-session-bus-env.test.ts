import { afterEach, describe, expect, it } from 'vitest'
import {
  repairDisabledSessionBusEnv,
  type SessionBusRepairOverrides
} from './dbus-session-bus-env'

describe('repairDisabledSessionBusEnv', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('repairs the disabled marker when the user bus socket exists', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const env: Record<string, string | undefined> = { DBUS_SESSION_BUS_ADDRESS: 'disabled:' }
    const overrides: SessionBusRepairOverrides = { uid: 1001, socketExists: () => true }

    repairDisabledSessionBusEnv(env, overrides)

    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/run/user/1001/bus')
  })

  it('leaves the marker when the user bus socket is missing', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const env: Record<string, string | undefined> = { DBUS_SESSION_BUS_ADDRESS: 'disabled:' }

    repairDisabledSessionBusEnv(env, { uid: 1001, socketExists: () => false })

    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('disabled:')
  })

  it('leaves a real bus address untouched', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const env: Record<string, string | undefined> = {
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1001/bus'
    }

    repairDisabledSessionBusEnv(env, { uid: 1001, socketExists: () => true })

    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/run/user/1001/bus')
  })

  it('leaves an absent address untouched', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const env: Record<string, string | undefined> = { HOME: '/home/user' }

    repairDisabledSessionBusEnv(env, { uid: 1001, socketExists: () => true })

    expect(env).toEqual({ HOME: '/home/user' })
  })

  it('does nothing off Linux', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const env: Record<string, string | undefined> = { DBUS_SESSION_BUS_ADDRESS: 'disabled:' }

    repairDisabledSessionBusEnv(env, { uid: 501, socketExists: () => true })

    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('disabled:')
  })

  it('runs the live socket check without overrides and without throwing', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const env: Record<string, string | undefined> = { DBUS_SESSION_BUS_ADDRESS: 'disabled:' }

    expect(() => repairDisabledSessionBusEnv(env)).not.toThrow()
  })
})
