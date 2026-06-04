import type { Session } from 'electron'

const FIDO_HID_USAGE_PAGE = 0xf1d0
const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

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

function isFidoHidDevice(device: Electron.HIDDevice | unknown): device is Electron.HIDDevice {
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

function handleBrowserSelectWebAuthnAccount(
  event: Electron.Event,
  details: Electron.SelectWebauthnAccountDetails,
  callback: (credentialId?: string | null) => void
): void {
  event.preventDefault()
  // Why: Electron cancels discoverable WebAuthn when no listener exists. Pick
  // only the unambiguous single-account case until Orca has account-picker UI.
  callback(details.accounts.length === 1 ? details.accounts[0].credentialId : null)
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
  browserSession.removeListener('select-webauthn-account', handleBrowserSelectWebAuthnAccount)
  browserSession.on('select-webauthn-account', handleBrowserSelectWebAuthnAccount)
}

export function clearBrowserWebAuthnAccessHandlers(browserSession: Session): void {
  browserSession.removeListener('select-hid-device', handleBrowserSelectHidDevice)
  browserSession.removeListener('select-webauthn-account', handleBrowserSelectWebAuthnAccount)
  browserSession.setDevicePermissionHandler(null)
}
