import { Platform } from 'react-native'
import { File as FsFile } from 'expo-file-system'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import {
  AssetField,
  MediaType,
  Query,
  presentPermissionsPicker,
  requestPermissionsAsync
} from 'expo-media-library'
import type { RecentPhotos } from './media-picker-contract'
import type { RecentPhotoDevice } from './native-recent-photos'

const RENDER_QUALITY = 0.92

// Android would need READ_MEDIA_IMAGES, which store policy reserves for gallery apps; its Photos picker stays the way in.
const RECENT_PHOTOS_SUPPORTED = Platform.OS === 'ios'

async function list(limit: number): Promise<RecentPhotos> {
  if (!RECENT_PHOTOS_SUPPORTED) {
    return { access: 'denied', ids: [] }
  }
  const permission = await requestPermissionsAsync(false, ['photo'])
  if (!permission.granted) {
    return { access: 'denied', ids: [] }
  }
  const assets = await new Query()
    .eq(AssetField.MEDIA_TYPE, MediaType.IMAGE)
    .orderBy({ key: AssetField.CREATION_TIME, ascending: false })
    .limit(limit)
    .exe()
  return {
    access: permission.accessPrivileges === 'limited' ? 'limited' : 'all',
    ids: assets.map((asset) => asset.id)
  }
}

// ph:// ids load straight from Photos, fetched from iCloud when needed.
async function render(id: string): Promise<{ uri: string; width: number; height: number }> {
  const image = await ImageManipulator.manipulate(id).renderAsync()
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: RENDER_QUALITY })
  return { uri: saved.uri, width: saved.width, height: saved.height }
}

async function manage(): Promise<boolean> {
  const permission = await requestPermissionsAsync(false, ['photo'])
  if (permission.accessPrivileges !== 'limited') {
    return false
  }
  await presentPermissionsPicker(['photo'])
  return true
}

function discard(uri: string): void {
  try {
    new FsFile(uri).delete()
  } catch {
    // Best effort; the cache is the OS's to reclaim.
  }
}

export const nativeRecentPhotoDevice: RecentPhotoDevice = {
  list,
  manage,
  render,
  discard
}
