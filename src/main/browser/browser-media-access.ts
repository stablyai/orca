import { systemPreferences } from 'electron'
import type { MediaAccessPermissionRequest } from 'electron'

// Why: macOS gates all camera/microphone access at the app-process level via
// TCC. Electron's per-session permission handlers run inside that envelope:
// if we call callback(true) but macOS has not granted the parent app, the
// stream is still empty. Conversely, if we deny at the session handler, pages
// never see the stream even when macOS has granted — which is the bug the user
// hit inside the in-app browser (#1273 only fixed Settings → Permissions, not
// the actual runtime getUserMedia() path).
//
// These helpers let both the main window session and the browser-tab sessions
// consult the same macOS-aware logic, so once a user has granted Camera or
// Microphone to Orca (via Settings → Permissions or directly in System
// Settings), a page inside an in-app browser tab actually receives the stream.

export function requestedMediaTypes(
  details: MediaAccessPermissionRequest | undefined
): Set<'audio' | 'video'> {
  return new Set(details?.mediaTypes ?? [])
}

export function hasSystemMediaAccess(mediaType: string | undefined): boolean {
  if (process.platform !== 'darwin') {
    return true
  }
  if (mediaType === 'audio') {
    return systemPreferences.getMediaAccessStatus('microphone') === 'granted'
  }
  if (mediaType === 'video') {
    return systemPreferences.getMediaAccessStatus('camera') === 'granted'
  }
  return false
}

export async function requestSystemMediaAccess(
  details: MediaAccessPermissionRequest | undefined
): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return true
  }

  const mediaTypes = requestedMediaTypes(details)
  if (mediaTypes.size === 0) {
    return false
  }

  if (mediaTypes.has('audio')) {
    // Why: macOS only shows the TCC prompt from the app process, so Chromium's
    // media grant is paired with the OS-level request at the actual media ask.
    const granted = await systemPreferences.askForMediaAccess('microphone')
    if (!granted) {
      return false
    }
  }
  if (mediaTypes.has('video')) {
    const granted = await systemPreferences.askForMediaAccess('camera')
    if (!granted) {
      return false
    }
  }
  return true
}
