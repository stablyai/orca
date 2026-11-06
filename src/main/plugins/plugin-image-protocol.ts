import { protocol } from 'electron'
import {
  PLUGIN_IMAGE_SCHEME,
  parsePluginImageUrl
} from '../../shared/plugins/images/plugin-image-url'
import { pluginThemeBackgroundPath } from './contributions/plugin-theme-background-image'
import { readCheckedPluginImage, type CheckedPluginImage } from './plugin-image-read'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { declaredPluginImages } from './plugin-image-artifact-validation'
import type { PluginImageCache } from './plugin-image-cache'

export type PluginImageProtocolDependencies = {
  cache: PluginImageCache
  findValidPlugin: (pluginKey: string) => ValidDiscoveredPlugin | null
}

/** An installed plugin's declared image or theme background, re-checked on every read like at install. */
async function readInstalledImage(
  plugin: ValidDiscoveredPlugin,
  contentHash: string,
  slot: string
): Promise<CheckedPluginImage | null> {
  if (contentHash !== (plugin.isDev ? 'dev' : plugin.contentHash)) {
    return null
  }
  const declared = declaredPluginImages(plugin.manifest).find(
    (candidate) => candidate.slot === slot
  )
  if (declared) {
    return readCheckedPluginImage(plugin.rootDir, declared.kind, declared.path)
  }
  const themeBackground = await pluginThemeBackgroundPath(plugin, slot)
  return themeBackground
    ? readCheckedPluginImage(plugin.rootDir, 'theme-background', themeBackground)
    : null
}

export function createPluginImageRequestHandler(
  dependencies: PluginImageProtocolDependencies
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405 })
    }
    const reference = parsePluginImageUrl(request.url)
    try {
      let image: CheckedPluginImage | null = null
      if (reference?.kind === 'sha') {
        image = await dependencies.cache.get(reference.sha256)
      } else if (reference?.kind === 'installed') {
        const plugin = dependencies.findValidPlugin(reference.pluginKey)
        image = plugin
          ? await readInstalledImage(plugin, reference.contentHash, reference.slot)
          : null
      }
      if (!image) {
        return new Response(null, { status: 404 })
      }
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(image.bytes), {
        headers: {
          'Content-Type': image.mimeType,
          'Content-Length': String(image.bytes.byteLength),
          // Why immutable is safe: a hash or install hash names exact bytes; dev trees change in place.
          'Cache-Control':
            reference?.kind === 'installed' && reference.contentHash === 'dev'
              ? 'no-store'
              : 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff'
        }
      })
    } catch {
      return new Response(null, { status: 404 })
    }
  }
}

export function installPluginImageProtocolHandler(
  dependencies: PluginImageProtocolDependencies
): void {
  protocol.handle(PLUGIN_IMAGE_SCHEME, createPluginImageRequestHandler(dependencies))
}
