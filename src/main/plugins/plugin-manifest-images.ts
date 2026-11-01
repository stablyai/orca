import type { PluginManifest } from '../../shared/plugins/manifest/plugin-manifest'
import {
  pluginInstalledImageUrl,
  type PluginHostImage,
  type PluginHostImages
} from '../../shared/plugins/images/plugin-image-url'

/** A format 2 manifest's images as the renderer loads them, given how each slot maps to a URL. */
export function pluginManifestHostImages(
  manifest: PluginManifest,
  urlFor: (slot: string, path: string) => string | null
): PluginHostImages | undefined {
  if (manifest.manifestVersion !== 2) {
    return undefined
  }
  const image = (slot: string, path: string, alt: string): PluginHostImage | null => {
    const url = urlFor(slot, path)
    return url ? { url, alt } : null
  }
  const icon = manifest.icon ? image('icon', manifest.icon, manifest.name) : null
  const cover = manifest.cover ? image('cover', manifest.cover.path, manifest.cover.alt) : null
  const screenshots = (manifest.screenshots ?? []).flatMap((shot, index) => {
    const host = image(`screenshot-${index}`, shot.path, shot.alt)
    return host
      ? [
          {
            ...host,
            ...(shot.caption ? { caption: shot.caption } : {}),
            ...(shot.theme ? { theme: shot.theme } : {})
          }
        ]
      : []
  })
  if (!icon && !cover && screenshots.length === 0) {
    return undefined
  }
  return {
    ...(icon ? { icon } : {}),
    ...(cover ? { cover } : {}),
    ...(screenshots.length ? { screenshots } : {})
  }
}

/** URLs for an installed plugin's images; no file is read until the renderer asks for one. */
export function pluginInstalledHostImages(
  pluginKey: string,
  contentHash: string | null,
  manifest: PluginManifest
): PluginHostImages | undefined {
  return pluginManifestHostImages(manifest, (slot) =>
    pluginInstalledImageUrl(pluginKey, contentHash ?? 'dev', slot)
  )
}
