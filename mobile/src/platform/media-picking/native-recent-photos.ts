import type {
  BridgeAddContextChoice,
  BridgeAddContextOptions
} from '../../mobile-web-shell/bridge/native-capabilities/bridge-add-context-verbs'
import type { RecentPhotos } from './media-picker-contract'
import type { PickedAsset } from './native-media'

export type RenderedRecentPhoto = { uri: string; width: number; height: number }

export type RecentPhotoDevice = {
  list: (limit: number) => Promise<RecentPhotos>
  manage: () => Promise<boolean>
  // A JPEG copy in the app cache, so HEIC originals reach agents in a format they read.
  render: (id: string) => Promise<RenderedRecentPhoto>
  discard: (uri: string) => void
}

// The shell's own sheet: ids are the photos the user tapped in it, never anything the page named.
export type AddContextPresenter = (
  options: BridgeAddContextOptions
) => Promise<{ choice: BridgeAddContextChoice; ids: readonly string[] }>

const RENDERED_MIME = 'image/jpeg'

export async function renderRecentPhotos(
  device: RecentPhotoDevice,
  ids: readonly string[]
): Promise<PickedAsset[]> {
  const rendered: PickedAsset[] = []
  try {
    for (const id of ids) {
      const photo = await device.render(id)
      rendered.push({ ...photo, mimeType: RENDERED_MIME })
    }
  } catch (error) {
    for (const asset of rendered) {
      device.discard(asset.uri)
    }
    throw error
  }
  return rendered
}
