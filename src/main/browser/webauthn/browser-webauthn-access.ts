import type { Session } from 'electron'
import {
  cancelBrowserWebAuthnAccountRequestsForSession,
  requestBrowserWebAuthnAccount
} from './browser-webauthn-account-picker'

const FIDO_HID_USAGE_PAGE = 0xf1d0
const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
type SelectWebAuthnAccountHandler = (
  event: Electron.Event,
  details: Electron.SelectWebauthnAccountDetails,
  callback: (credentialId?: string | null) => void
) => Promise<void>
const selectWebAuthnAccountHandlers = new WeakMap<Session, SelectWebAuthnAccountHandler>()

function isSecureBrowserOrigin(rawOrigin: string | undefined): boolean {
  if (!rawOrigin) {
    return false
  }
  try {
    const origin = new URL(rawOrigin)
    return origin.protocol === 'https:' || LOCALHOST_HOSTNAMES.has(origin.hostname)
  } catch {
    return false
  }
}

function isFidoHidDevice(device: unknown): device is Electron.HIDDevice {
  if (!device || typeof device !== 'object') {
    return false
  }
  const collections = (device as { collections?: unknown }).collections
  return (
    Array.isArray(collections) &&
    collections.some((collection) => {
      return (
        collection &&
        typeof collection === 'object' &&
        (collection as { usagePage?: unknown }).usagePage === FIDO_HID_USAGE_PAGE
      )
    })
  )
}

export function allowsBrowserWebAuthnPermission(
  permission: string,
  details?: { securityOrigin?: string }
): boolean {
  return permission === 'hid' && isSecureBrowserOrigin(details?.securityOrigin)
}

function handleBrowserSelectHidDevice(
  event: Electron.Event,
  details: Electron.SelectHidDeviceDetails,
  callback: (deviceId?: string) => void
): void {
  event.preventDefault()
  if (!isSecureBrowserOrigin(details.frame?.url)) {
    callback(undefined)
    return
  }
  const selectedDevice = details.deviceList.find(isFidoHidDevice)
  callback(selectedDevice?.deviceId)
}

async function handleBrowserSelectWebAuthnAccount(
  browserSession: Session,
  event: Electron.Event,
  details: Electron.SelectWebauthnAccountDetails,
  callback: (credentialId?: string | null) => void
): Promise<void> {
  event.preventDefault()
  if (details.accounts.length <= 1) {
    callback(details.accounts[0]?.credentialId ?? null)
    return
  }
  let credentialId: string | null = null
  try {
    credentialId = await requestBrowserWebAuthnAccount(details, browserSession)
  } finally {
    callback(credentialId)
  }
}

export function installBrowserWebAuthnAccessHandlers(browserSession: Session): void {
  browserSession.setDevicePermissionHandler((details) => {
    return (
      details.deviceType === 'hid' &&
      isSecureBrowserOrigin(details.origin) &&
      isFidoHidDevice(details.device)
    )
  })
  browserSession.removeListener('select-hid-device', handleBrowserSelectHidDevice)
  browserSession.on('select-hid-device', handleBrowserSelectHidDevice)
  const previousHandler = selectWebAuthnAccountHandlers.get(browserSession)
  if (previousHandler) {
    browserSession.removeListener('select-webauthn-account', previousHandler)
  }
  const selectWebAuthnAccountHandler: SelectWebAuthnAccountHandler = (event, details, callback) =>
    handleBrowserSelectWebAuthnAccount(browserSession, event, details, callback)
  selectWebAuthnAccountHandlers.set(browserSession, selectWebAuthnAccountHandler)
  browserSession.on('select-webauthn-account', selectWebAuthnAccountHandler)
}

export function clearBrowserWebAuthnAccessHandlers(browserSession: Session): void {
  browserSession.removeListener('select-hid-device', handleBrowserSelectHidDevice)
  const selectWebAuthnAccountHandler = selectWebAuthnAccountHandlers.get(browserSession)
  if (selectWebAuthnAccountHandler) {
    browserSession.removeListener('select-webauthn-account', selectWebAuthnAccountHandler)
    selectWebAuthnAccountHandlers.delete(browserSession)
  }
  browserSession.setDevicePermissionHandler(null)
  cancelBrowserWebAuthnAccountRequestsForSession(browserSession)
}
