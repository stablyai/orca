import { nativeImage, type NativeImage } from 'electron'
import type { RepoIcon } from '../../shared/repo-icon'

// Why: only locally stored data-URL images; github/favicon icons would need a network fetch per banner.
// nativeImage cannot decode WebP, so a WebP upload comes back empty and the banner keeps no icon.
export function notificationIconFromRepoIcon(
  icon: RepoIcon | null | undefined
): NativeImage | undefined {
  if (icon?.type !== 'image' || (icon.source !== 'upload' && icon.source !== 'file')) {
    return undefined
  }
  const image = nativeImage.createFromDataURL(icon.src)
  return image.isEmpty() ? undefined : image
}
