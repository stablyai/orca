import { execFile } from 'node:child_process'
import dgram from 'node:dgram'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { ipcMain, shell, systemPreferences } from 'electron'
import type {
  DeveloperPermissionId,
  DeveloperPermissionRequestResult,
  DeveloperPermissionState,
  DeveloperPermissionStatus
} from '../../shared/developer-permissions-types'

const PRIVACY_PANE_URLS: Partial<Record<DeveloperPermissionId, string>> = {
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  'full-disk-access': 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  bluetooth: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Bluetooth'
}

const DEVELOPER_PERMISSION_IDS: DeveloperPermissionId[] = [
  'microphone',
  'camera',
  'screen',
  'accessibility',
  'full-disk-access',
  'automation',
  'local-network',
  'usb',
  'bluetooth'
]

function unsupportedOffMac(): DeveloperPermissionStatus | null {
  return process.platform === 'darwin' ? null : 'unsupported'
}

function getMediaStatus(mediaType: 'microphone' | 'camera' | 'screen'): DeveloperPermissionStatus {
  const unsupported = unsupportedOffMac()
  if (unsupported) {
    return unsupported
  }
  try {
    return systemPreferences.getMediaAccessStatus(mediaType)
  } catch {
    return 'unknown'
  }
}

async function getFullDiskAccessStatus(): Promise<DeveloperPermissionStatus> {
  const unsupported = unsupportedOffMac()
  if (unsupported) {
    return unsupported
  }
  try {
    // Why: Safari bookmarks are TCC-protected, so read access is a practical
    // Full Disk Access signal without touching user project contents.
    await access(path.join(homedir(), 'Library', 'Safari', 'Bookmarks.plist'))
    return 'granted'
  } catch {
    return 'unknown'
  }
}

function getAccessibilityStatus(): DeveloperPermissionStatus {
  const unsupported = unsupportedOffMac()
  if (unsupported) {
    return unsupported
  }
  return systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'unknown'
}

async function openPrivacyPane(id: DeveloperPermissionId): Promise<boolean> {
  const url = PRIVACY_PANE_URLS[id]
  if (!url) {
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension'
    )
    return true
  }
  await shell.openExternal(url)
  return true
}

function triggerAppleEventsPrompt(): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      'osascript',
      ['-e', 'tell application "System Events" to return 1'],
      { timeout: 3000 },
      () => resolve()
    )
  })
}

function triggerLocalNetworkPrompt(): Promise<void> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    let settled = false
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      try {
        socket.close()
      } catch {
        // Already closed or never fully bound.
      }
      resolve()
    }
    socket.on('error', finish)
    socket.bind(() => {
      const message = Buffer.from([0])
      socket.send(message, 0, message.length, 5353, '224.0.0.251', finish)
    })
    setTimeout(finish, 1000)
  })
}

async function getPermissionState(id: DeveloperPermissionId): Promise<DeveloperPermissionState> {
  switch (id) {
    case 'microphone':
    case 'camera':
    case 'screen':
      return { id, status: getMediaStatus(id) }
    case 'accessibility':
      return { id, status: getAccessibilityStatus() }
    case 'full-disk-access':
      return { id, status: await getFullDiskAccessStatus() }
    case 'automation':
    case 'local-network':
      return { id, status: unsupportedOffMac() ?? 'unknown' }
    case 'usb':
    case 'bluetooth':
      return { id, status: unsupportedOffMac() ?? 'ready' }
  }
}

async function requestPermission(
  id: DeveloperPermissionId
): Promise<DeveloperPermissionRequestResult> {
  if (process.platform !== 'darwin') {
    return { id, status: 'unsupported', openedSystemSettings: false }
  }

  if (id === 'microphone' || id === 'camera') {
    // Why: askForMediaAccess only surfaces the TCC prompt when status is
    // 'not-determined'. If the user previously denied (or macOS set the status
    // to 'denied'/'restricted'), it resolves false with no prompt — leaving
    // the user stuck. Fall through to the Privacy pane so they can toggle it.
    const granted = await systemPreferences.askForMediaAccess(id)
    if (granted) {
      return { id, status: 'granted', openedSystemSettings: false }
    }
    const status = getMediaStatus(id)
    if (status === 'denied' || status === 'restricted' || status === 'unknown') {
      await openPrivacyPane(id)
      return { id, status, openedSystemSettings: true }
    }
    return { id, status, openedSystemSettings: false }
  }

  if (id === 'accessibility') {
    // Why: isTrustedAccessibilityClient(true) shows the prompt only the first
    // time for a given bundle. Once the user has dismissed or denied, calling
    // it again is a no-op. Fall through to the Privacy pane when not granted.
    const trusted = systemPreferences.isTrustedAccessibilityClient(true)
    if (trusted) {
      return { id, status: 'granted', openedSystemSettings: false }
    }
    await openPrivacyPane(id)
    return { id, status: getAccessibilityStatus(), openedSystemSettings: true }
  }

  if (id === 'automation') {
    await triggerAppleEventsPrompt()
    return { id, status: 'unknown', openedSystemSettings: false }
  }

  if (id === 'local-network') {
    await triggerLocalNetworkPrompt()
    return { id, status: 'unknown', openedSystemSettings: false }
  }

  await openPrivacyPane(id)
  return { id, status: (await getPermissionState(id)).status, openedSystemSettings: true }
}

export function registerDeveloperPermissionHandlers(): void {
  ipcMain.handle(
    'developerPermissions:getStatus',
    async (): Promise<DeveloperPermissionState[]> => {
      return Promise.all(DEVELOPER_PERMISSION_IDS.map(getPermissionState))
    }
  )

  ipcMain.handle(
    'developerPermissions:request',
    async (
      _event,
      args: { id: DeveloperPermissionId }
    ): Promise<DeveloperPermissionRequestResult> => {
      if (!DEVELOPER_PERMISSION_IDS.includes(args.id)) {
        return { id: args.id, status: 'unsupported', openedSystemSettings: false }
      }
      return requestPermission(args.id)
    }
  )

  ipcMain.handle(
    'developerPermissions:openSettings',
    async (_event, args: { id: DeveloperPermissionId }): Promise<void> => {
      await openPrivacyPane(args.id)
    }
  )
}
