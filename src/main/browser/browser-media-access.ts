import { systemPreferences } from 'electron'
import type { MediaAccessPermissionRequest } from 'electron'

// macOS requires app-level TCC grants as well as Electron session grants.

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
